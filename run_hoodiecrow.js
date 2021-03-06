#!/usr/bin/env node

// This file is invoked from XPCOM-land by fake-server-support.js. It passes us
// some JSON options via process.argv, and we're expected to contact the control
// server after we have spun up a set of hoodiecrow IMAP+SMTP servers.

var request = require('request');
var hoodiecrow = require('hoodiecrow');
var mimeparser = require('hoodiecrow/lib/mimeparser')
var simplesmtp = require('simplesmtp');
var http = require('http');


// Pull out the arguments as passed from fake-server-support, treating the last
// argument passed as a JSON string, e.g.:
//
// args = {
//   serverId: (number),
//   controlUrl: "http://...",
//   credentials: creds,
//   options: opts,
//   deliveryMode: 'inbox' or 'blackhole'
// }

var args = JSON.parse(process.argv[process.argv.length - 1]);
console.log('Started hoodiecrow node process. Args:', JSON.stringify(args));

var imapServer = startImapServer();
var smtpServer = startSmtpServer();
var sendShouldFail = false;

/**
 * The startup handshake for hoodiecrow looks like this:
 *
 * 1. The mail-fakeservers control server receives a "make_hoodiecrow" request.
 *    It spawns this file in Node, and holds onto the "make_hoodiecrow" request.
 *
 * 2. We ping the control server with a 'hoodiecrow_ready' message, with details
 *    about the IMAP/SMTP ports.
 *
 * 3. The mail-fakeservers control server then responds to the original
 *    "make_hoodiecrow" request, such that it appears synchronous from GELAM's
 *    point of view.
 */
function main() {
  var backdoorServer = startBackdoorServer(handleRequest);

  updateCredentials(args.credentials);
  if (args.options.oauth) {
    updateCredentials({
      accessToken: args.options.oauth.initialTokens.accessToken
    });
  }

  sendReadyMessageToControlServer(args.controlUrl, {
    command: 'hoodiecrow_ready',
    serverId: args.serverId,
    controlUrl: 'http://localhost:' + backdoorServer.address().port,
    imapHost: 'localhost',
    imapPort: imapServer.server.address().port,
    smtpHost: 'localhost',
    smtpPort: smtpServer.server.SMTPServer._server.address().port,
    oauthInfo: null
  });
}

var currentDateMS = null;
function getCurrentDate() {
  if (currentDateMS) {
    var date = new Date(currentDateMS);
    currentDateMS += 1000;
    return date;
  } else {
    return new Date(Date.now());
  }
}






// A plugin to force the server to not return UIDNEXT from SELECT.
function NOUIDNEXT(imapServer) {
  imapServer.setCommandHandler(
    'SELECT', require('./hoodiecrow-mods/select-nouidnext'));
}

// A plugin to remove the timezone part from INTERNALDATE representations.
function NO_INTERNALDATE_TZ(imapServer) {
  imapServer.formatInternalDate = function(date) {
    var day = date.getDate(),
      month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
      ][date.getMonth()],
      year = date.getFullYear(),
      hour = date.getHours(),
      minute = date.getMinutes(),
      second = date.getSeconds(),
      tz = date.getTimezoneOffset(),
      tzHours = Math.abs(Math.floor(tz / 60)),
      tzMins = Math.abs(tz) - tzHours * 60;

    return (day < 10 ? "0" : "") + day + "-" + month + "-" + year + " " +
      (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") +
      minute + ":" + (second < 10 ? "0" : "") + second;
  };
}


var currentCredentials = {};
function updateCredentials(obj) {
  currentCredentials = {
    username: obj.username || currentCredentials.username,
    password: obj.password || currentCredentials.password,
    accessToken: obj.accessToken || currentCredentials.accessToken,
    outgoingPassword: (obj.outgoingPassword ||
                       currentCredentials.outgoingPassword ||
                       currentCredentials.password ||
                       obj.password)
  };

  console.log('Hoodiecrow credentials updated:',
              JSON.stringify(currentCredentials));

  imapServer.users = {};
  imapServer.users[currentCredentials.username] = {
    password: currentCredentials.password,
    xoauth2: (currentCredentials.accessToken ? {
      accessToken: currentCredentials.accessToken,
      sessionTimeout: 3600 * 1000
    } : null)
  };

  smtpServer.server.removeAllListeners('authorizeUser');
  smtpServer.server.on('authorizeUser', function(conn, user, pass, cb) {
    if (user === currentCredentials.username &&
        (currentCredentials.accessToken
          ? pass === currentCredentials.accessToken
          : pass === currentCredentials.outgoingPassword)) {
      cb(null, true);
    } else {
      cb('wrong username/password', false);
    }
  });
}

/**
 * Create the folder configuration.  There are three modes:
 *
 * - "flat" / (default): The folders are not namespaced under the INBOX.
 * - "underinbox": The folders are namespaced under the INBOX.  This is
 *    historically done dynamically by issuing a
 *    "moveSystemFoldersUnderneathInbox" request.
 * - "custom": Uses the "folderConfig" idiom created prior to adopting
 *    hoodiecrow.  This is being left as-is structurally for consistency with
 *    the legacy imapd logic, but we should probably just change to directly
 *    propagating the structure directly to what hoodiecrow consumes once we
 *    need to make a significant change to this.
 *
 * NOTE: It turns out hoodiecrow has some (known, admitted) awkwardness with
 * how it handles the INBOX folder and namespaces.  This should all be
 * overhauled in conjunction with improving upstream hoodiecrow.
 */
function makeFolderStorage(modeOrConfig) {
  var mode, folderDefs;
  if (!modeOrConfig) {
    mode = 'flat';
  } else if (typeof(modeOrConfig) === 'string') {
    mode = modeOrConfig;
  } else if (!modeOrConfig.folders) {
    if (modeOrConfig.underInbox) {
      mode = 'underinbox';
    } else {
      mode = 'flat';
    }
  } else {
    mode = 'custom';
    folderDefs = modeOrConfig.folders;
  }

  if (mode === 'flat') {
    return {
      'INBOX': {},
      '': { // (implied personal namespace)
        separator: '/',
        folders: {
          'Drafts': { 'special-use': '\\Drafts' },
          'Sent': { 'special-use': '\\Sent' },
          'Trash': { 'special-use': '\\Trash' },
          'Custom': { }
        }
      }
    };
  } else if (mode === 'underinbox') {
    return {
      'INBOX': {
      },
      'INBOX/': { // documentme: why is the personal namespace still under ''?
        type: 'personal',
        separator: '/',
        folders: {
          'Drafts': { 'special-use': '\\Drafts' },
          'Sent': { 'special-use': '\\Sent' },
          'Trash': { 'special-use': '\\Trash' },
          'Custom': { }
        }
      }
    };
  } else if (mode === 'custom') {
    var foldersByPath = {};
    folderDefs.forEach(function(folderDef) {
      var meta = {};
      if (folderDef['special-use']) {
        meta['special-use'] = folderDef['special-use'];
      }
      foldersByPath[folderDef.name] = meta;
    });

    var storage = {
      'INBOX': {}
    };

    if (modeOrConfig.underInbox) {
      storage['INBOX/'] = {
        type: 'personal',
        separator: '/',
        folders: foldersByPath
      };
    } else {
      storage[''] = {
        separator: '/',
        folders: foldersByPath
      };
    }
    return storage;
  };
}

function handleRequest(msg) {
  switch (msg.command) {
    case 'getFolderByPath':
      var folder = imapServer.getMailbox(msg.name);
      if (folder) {
        return folder.path;
      } else {
        return null;
      }
      break;
    case 'setDate':
      currentDateMS = msg.timestamp;
      break;
    case 'addFolder':
      imapServer.createMailbox(msg.name);
      return imapServer.getMailbox(msg.name).path;
    case 'removeFolder':
      imapServer.deleteMailbox(msg.name);
      break;
    case 'addMessagesToFolder':
      msg.messages.forEach(function(message) {
        imapServer.appendMessage(
          msg.name,
          message.flags,
          new Date(message.date),
          new Buffer(message.msgString));
      });
      break;
    case 'modifyMessagesInFolder':
      var name = msg.name;
      var uids = msg.uids;
      var addFlags = msg.addFlags;
      var delFlags = msg.delFlags;
      var mailbox = imapServer.getMailbox(name);
      mailbox.messages.forEach(function(message) {
        if (msg.uids.indexOf(message.uid) !== -1) {
          addFlags && addFlags.forEach(function(flag) {
            imapServer.ensureFlag(message.flags, flag);
          });
          delFlags && delFlags.forEach(function(flag) {
            imapServer.removeFlag(message.flags, flag);
          });
        }
      });
      break;
    case 'getMessagesInFolder':
      var name = msg.name;
      var mailbox = imapServer.getMailbox(name);
      return mailbox.messages.map(function(message) {
        var mimeMsg = mimeparser(message.raw);
        return {
          date: mimeMsg.internaldate,
          subject: mimeMsg.parsedHeader['subject']
        };
      });
      break;
    case 'setValidOAuthAccessTokens':
      // XXX: Only using one token for now.
      updateCredentials({ accessToken: msg.accessTokens[0] });
      break;
    case 'changeCredentials':
      updateCredentials(msg.credentials);
      break;
    case 'toggleSendFailure':
      sendShouldFail = msg.shouldFail;
      break;
    case 'moveSystemFoldersUnderneathInbox':
      imapServer.folderCache = {};
      imapServer.storage = makeFolderStorage('underinbox');
      // indexFolders is not intended to be used multiple times, irrevocably
      // mutating referenceNamespace, so we need to reset it here.
      imapServer.referenceNamespace = false;
      imapServer.indexFolders();
      break;
  }
}



function withBufferAsString(req, fn) {
  var body = '';
  req.on('data', function(arr) {
    body += arr.toString('utf-8');
  });
  req.on('end', function() {
    fn(body);
  });
}

function startBackdoorServer(handler) {
  var server = http.createServer(function(req, res) {
    withBufferAsString(req, function(body) {
      try {
        var responseBody = handler(JSON.parse(body), req, res);
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(JSON.stringify(responseBody));
      } catch(e) {
        console.error('Internal hoodiecrow backdoor error:', e, e.stack);
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.listen(0);
  return server;
}

function startImapServer() {
  var plugins = [
    "ID", "STARTTLS", "SASL-IR",
    "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "CONDSTORE",
    "LITERALPLUS", "UNSELECT", "SPECIAL-USE",
    "CREATE-SPECIAL-USE", "XOAUTH2"
  ];

  if (args.options.imapExtensions &&
      args.options.imapExtensions.indexOf('NOUIDNEXT') !== -1){
    plugins.push(NOUIDNEXT);
  }

  if (args.options.imapExtensions &&
      args.options.imapExtensions.indexOf('NO_INTERNALDATE_TZ') !== -1){
    plugins.push(NO_INTERNALDATE_TZ);
  }

  var imapServer = hoodiecrow({
    debug: true,
    storage: makeFolderStorage(args.options.folderConfig),
    plugins: plugins,
  });
  imapServer.listen(0);
  return imapServer;
}

function startSmtpServer() {
  // Spin up the SMTP server. This is mainly boilerplate derived from
  // hoodiecrow/bin/hoodiecrow, which just wraps simplesmtp:
  var smtpServer = simplesmtp.createSimpleServer({
    SMTPBanner: "Hoodiecrow",
    enableAuthentication: true,
    debug: false,
    disableDNSValidation: true,
    authMethods: ['XOAUTH2', 'PLAIN', 'LOGIN']
  }, function(req) {
    if (sendShouldFail) {
      req.reject();
    } else {
      withBufferAsString(req, function(body) {
        if (args.deliveryMode !== 'blackhole') {
          // XXX we need to switch to https://github.com/andris9/smtp-server
          // which understands how to do dot removal
          body = body.replace(/\n\./g, '\n');
          imapServer.appendMessage(
            'INBOX',
            /* flags: */ [],
            getCurrentDate(),
            new Buffer(body));
        }
        req.accept();
      });
    }
  });
  smtpServer.listen(0);
  return smtpServer;
}

function sendReadyMessageToControlServer(controlUrl, args) {
  request({
    url: controlUrl,
    json: true,
    body: args
  }, function(error, response) {
    if (error) {
      console.error('Hoodiecrow process got error from control server:', error);
      process.exit(1);
      return;
    }
  });
}

main();
