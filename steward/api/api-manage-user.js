var sqlite3     = require('sqlite3')
  , speakeasy   = require('speakeasy')
  , steward     = require('./../core/steward')
  , manage      = require('./../routes/route-manage')
  ;



var users = {};
var clients = {};


var create = function(logger, ws, api, message, tag) {
  var alg, data, options, results, uuid, x;

  var error = function(permanent, diagnostic) {
    return manage.error(ws, tag, 'user creation', message.requestID, permanent, diagnostic);
  };

  if (!exports.db)                                          return error(false, 'database not ready');

  uuid = message.path.slice(api.prefix.length + 1);
  if (uuid.length === 0)                                    return error(true,  'missing uuid');

  if (!message.name)                                        return error(true,  'missing name element');
  if (!message.name.length)                                 return error(true,  'empty name element');
  if ((message.name.search(/\s/)      !== -1)
        || (message.name.indexOf('-') ===  0)
        || (message.name.indexOf('/') !== -1)
        || (message.name.indexOf('.') !== -1)
        || (message.name.indexOf(':') !== -1))              return error(true,  'invalid name element');


  if (!message.comments) message.comments = '';

  if (!message.role) message.role = 'resident';
  message.role = message.role.toLowerCase();
  if (!{ master   : true
       , resident : true
       , guest    : true
       , device   : true
       , cloud    : true
       , none     : true }[message.role])                   return error(true,  'invalid role element');

  if (!message.clientName) message.clientName = '';

  if (!!users[uuid])                                        return error(false, 'duplicate uuid');
  if (!!name2user[message.name])                            return error(false, 'duplicate name');
  users[uuid] = {};

  results = { requestID: message.requestID };
  try { ws.send(JSON.stringify(results)); } catch (ex) { console.log(ex); }

  alg = 'otpauth://totp';
  options = { length         : 40
            , random_bytes   : false
            , symbols        : false
            , google_auth_qr : true
            , name           : '/user/' + message.name
            , issuer         : 'steward'
            };
  data = speakeasy.generate_key(options);

  exports.db.run('INSERT INTO users(userUID, userName, userComments, userRole, created) '
                 + 'VALUES($userUID, $userName, $userComments, $userRole, datetime("now"))',
                 { $userUID: uuid, $userName: message.name, $userComments: message.comments, $userRole: message.role },
                 function(err) {
    var userID;

    if (err) {
      delete(users[uuid]);
      logger.error(tag, { user: 'INSERT users.userUID for ' + uuid, diagnostic: err.message });
      results.error = { permanent: false, diagnostic: 'internal error' };
      try { ws.send(JSON.stringify(results)); } catch (ex) { console.log(ex); }
      return;
    }

    userID = this.lastID.toString();

    results.result = { user             : userID
                     , authenticatorURL : data.google_auth_qr
                     , otpURL           : data.url()
                     };
    users[uuid] = { userID         : userID
                  , userUID        : uuid
                  , userName       : message.name
                  , userComments   : message.comments
                  , userRole       : message.role
                  , userLastLogin  : null
                  , clients        : []
                  };

    exports.db.run('INSERT INTO clients(clientUID, clientUserID, clientName, clientComments, clientAuthAlg, clientAuthParams, '
                   + 'clientAuthKey, created) '
                   + 'VALUES($clientUID, $clientUserID, $clientName, $clientComments, $clientAuthAlg, $clientAuthParams, '
                   + '$clientAuthKey, datetime("now"))',
                   { $clientUID: uuid, $clientUserID: userID, $clientName: message.clientName, $clientComments: '',
                     $clientAuthAlg: alg, $clientAuthParams: JSON.stringify(data.params), $clientAuthKey: data.base32 },
                   function(err) {
      var clientID;

      if (err) {
        logger.error(tag, { user: 'INSERT clients.clientUID for ' + uuid, diagnostic: err.message });
        results.error = { permanent: false, diagnostic: 'internal error' };
        try { ws.send(JSON.stringify(results)); } catch (ex) { console.log(ex); }
        return;
      }

      clientID = this.lastID.toString();

      data.params.name = '/user/' + message.name + '/' + clientID;
      x = data.google_auth_qr.indexOf('otpauth://totp/');
      if (x > 0) {
        data.google_auth_qr = data.google_auth_qr.slice(0, x) + 'otpauth://totp/' + encodeURIComponent(data.params.name)
                              + '%3Fsecret=' + encodeURIComponent(data.base32);
      }
      exports.db.run('UPDATE clients SET clientAuthParams=$clientAuthParams WHERE clientID=$clientID',
                     { $clientID: clientID, $clientAuthParams: JSON.stringify(data.params) }, function(err) {
        if (err) logger.error(tag, { event: 'UPDATE client.authParams for ' + clientID, diagnostic: err.message });
      });

      results.result.client = clientID;
      results.result.authenticatorURL = data.google_auth_qr;
      results.result.otpURL = data.url();
      clients[uuid] = { clientID         : clientID
                      , clientUID        : uuid
                      , clientUserID     : userID
                      , clientName       : message.clientName
                      , clientComments   : ''
                      , clientAuthAlg    : alg
                      , clientAuthParams : data.params
                      , clientAuthKey    : data.base32
                      , clientLastLogin  : null
                    };
      users[uuid].clients.push(clientID);

      try { ws.send(JSON.stringify(results)); } catch (ex) { console.log(ex); }
    });
  });

  return true;
};

var list = function(logger, ws, api, message, tag) {/* jshint unused: false */
  var allP, client, i, id, results, suffix, treeP, user, uuid;

  if (!exports.db) return manage.error(ws, tag, 'user listing', message.requestID, false, 'database not ready');

  allP = message.options.depth === 'all';
  treeP = allP || (message.options.depth === 'tree');
  suffix = message.path.slice(api.prefix.length + 1);
  if (suffix.length === 0) suffix = null;

  results = { requestID: message.requestID, result: { users: {} } };
  if (allP) {
    results.result.users = {};
    results.result.clients = {};
  }
  for (uuid in users) {
    if (!users.hasOwnProperty(uuid)) continue;

    user = users[uuid];
    id = user.userID;
    if ((!suffix) || (suffix === id)) {
      results.result.users['user/' + user.userName] = proplist(null, user);

      if (treeP) results.result.users['user/' + user.userName].clients = user.clients;
      for (i = 0; i < user.clients.length; i++) {
        client = id2client(user, user.clients[i]);
        results.result.clients['user/' + user.userName + '/' + client.clientID] = proplist2(null, client, user);
      }
    }
  }

  try { ws.send(JSON.stringify(results)); } catch (ex) { console.log(ex); }
  return true;
};

var authenticate = function(logger, ws, api, message, tag) {
  var client, clientID, date, now, otp, pair, results, user;

  var error = function(permanent, diagnostic) {
    return manage.error(ws, tag, 'user authentication', message.requestID, permanent, diagnostic);
  };

  if (!exports.db)                                          return error(false, 'database not ready');

  clientID = message.path.slice(api.prefix.length + 1);
  if (clientID.length === 0)                                return error(true,  'missing clientID');
  pair = clientID.split('/');
  if (pair.length !== 2)                                    return error(true,  'invalid clientID element');
  user = name2user(pair[0]);

  if (!message.response)                                    return error(true,  'missing response element');
  if (message.response.length < 6)                          return error(true,  'invalid response element');

  if (!user)                                                return error(false, 'invalid clientID/response pair');
  client = id2client(user, pair[1]);
  if (!client)                                              return error(false, 'invalid clientID/response pair');
  if (client.clientAuthAlg !== 'otpauth://totp')            return error(true,  'internal error');

  results = { requestID: message.requestID };
  otp = speakeasy.totp({ key      : client.clientAuthKey
                       , length   : message.response.length
                       , encoding : 'base32'
                       , step     : client.clientAuthParams.step
                       });
  if (otp !== message.response) {
    results.error = { permanent: false, diagnostic: 'invalid clientID/response pair' };
  } else {
    results.result = { user : user.userID, role: user.userRole };
    ws.userID = user.userID;

    logger.notice(tag, { event: 'login', clientID: clientID, role: user.userRole });

    now = new Date();
// http://stackoverflow.com/questions/5129624/convert-js-date-time-to-mysql-datetime
    date = now.getUTCFullYear()                         + '-'
           + ('00' + (now.getUTCMonth() + 1)).slice(-2) + '-'
           + ('00' + now.getUTCDate()).slice(-2)        + ' '
           + ('00' + now.getUTCHours()).slice(-2)       + ':'
           + ('00' + now.getUTCMinutes()).slice(-2)     + ':'
           + ('00' + now.getUTCSeconds()).slice(-2);
    exports.db.run('UPDATE users SET userLastLogin=$now WHERE userID=$userID',
                   { $userID: user.userID, $now: date }, function(err) {
      if (err) {
        logger.error(tag, { event: 'UPDATE user.lastLogin for ' + user.userID, diagnostic: err.message });
      } else {
        user.userLastLogin = now;
      }
    });
    exports.db.run('UPDATE clients SET clientLastLogin=$now WHERE clientID=$clientID',
                   { $clientID: client.clientID, $now: date }, function(err) {
      if (err) {
        logger.error(tag, { event: 'UPDATE client.lastLogin for ' + client.clientID, diagnostic: err.message });
      } else {
        client.clientLastLogin = now;
      }
    });
  }

  try { ws.send(JSON.stringify(results)); } catch (ex) { console.log(ex); }
  return true;
};


var name2user = function(name) {
  var uuid;

  if (!!name) for (uuid in users) if ((users.hasOwnProperty(uuid)) && (name === users[uuid].userName)) return users[uuid];
  return null;
};

exports.id2user = function(id) {
  var uuid;

  if (!!id) for (uuid in users) if ((users.hasOwnProperty(uuid)) && (id === users[uuid].userID)) return users[uuid];
  return null;
};

var proplist = function(id, user) {
  var result = { uuid      : user.userUID
               , name      : user.userName
               , comments  : user.userComments
               , role      : user.userRole
               , lastLogin : user.userLastLogin && new Date(user.userLastLogin)
               };

  if (!!id) {
    result.whatami =  '/user';
    result.whoami = 'user/' + user.userName;
  }

  return result;
};

var proplist2 = function(id, client, user) {
  var result = { uuid      : client.clientUID
               , name      : client.clientName
               , comments  : client.clientComments
               , lastLogin : client.clientLastLogin && new Date(client.clientLastLogin)
               };

  if (!!id) {
    result.whatami =  '/client';
    result.whoami = 'user/' + user.userName + '/' + id;
  }

  return result;
};

var id2client = function(user, id) {
  var i, uuid;

  if (!id) return null;

  for (uuid in clients) {
    if ((clients.hasOwnProperty(uuid)) && (id === clients[uuid].clientID)) {
      for (i = 0; i < user.clients.length; i++) if (id === user.clients[i]) return clients[uuid];

      break;
    }
  }

  return null;
};


exports.start = function() {
  var db;

  try {
    db = new sqlite3.Database(__dirname + '/../db/users.db');
  } catch(ex) {
    return steward.logger.emerg('database', { event: 'create ' + __dirname + '/../db/users.db', diagnostic: ex.message });
  }

  db.serialize(function() {
    db.run('CREATE TABLE IF NOT EXISTS users('
           + 'userID INTEGER PRIMARY KEY ASC, userUID TEXT, userName TEXT, userComments TEXT, userRole TEXT, '
           + 'userLastLogin CURRENT_TIMESTAMP, '
           + 'sortOrder INTEGER default "0", '
           + 'created CURRENT_TIMESTAMP, updated CURRENT_TIMESTAMP'
           + ')');
    db.run('CREATE TRIGGER IF NOT EXISTS t01 AFTER INSERT ON users BEGIN '
           + 'UPDATE users SET sortOrder=NEW.userID WHERE userID=NEW.userID AND sortOrder=0; '
           + 'END');
    db.run('CREATE TRIGGER IF NOT EXISTS t02 AFTER UPDATE ON users BEGIN '
           + 'UPDATE users SET updated=datetime("now") WHERE userID=NEW.userID; '
           + 'END');

    db.run('CREATE TABLE IF NOT EXISTS clients('
           + 'clientID INTEGER PRIMARY KEY ASC, clientUID TEXT, clientUserID INTEGER DEFAULT "0", '
           + 'clientName TEXT, clientComments TEXT, '
           + 'clientAuthAlg TEXT, clientAuthParams TEXT, clientAuthKey TEXT, clientLastLogin CURRENT_TIMESTAMP, '
           + 'sortOrder INTEGER default "0", '
           + 'created CURRENT_TIMESTAMP, updated CURRENT_TIMESTAMP'
           + ')');
    db.run('CREATE TRIGGER IF NOT EXISTS t01 AFTER INSERT ON clients BEGIN '
           + 'UPDATE clients SET sortOrder=NEW.clientID WHERE clientID=NEW.clientID AND sortOrder=0; '
           + 'END');
    db.run('CREATE TRIGGER IF NOT EXISTS t02 AFTER UPDATE ON clients BEGIN '
           + 'UPDATE clients SET updated=datetime("now") WHERE clientID=NEW.clientID; '
           + 'END');
    db.run('CREATE TRIGGER IF NOT EXISTS t03 AFTER DELETE ON users BEGIN '
           + 'DELETE FROM clients WHERE clientUserID=OLD.userID; '
           + 'END');

    db.all('SELECT * FROM users ORDER BY sortOrder', function(err, rows) {
      if (err) return steward.logger.error('database', { event: 'SELECT users.*', diagnostic: err.message });

      rows.forEach(function(user) {
        var userUUID = user.userUID;

        users[userUUID] = { userID         : user.userID.toString()
                          , userUID        : userUUID
                          , userName       : user.userName
                          , userComments   : user.userComments
                          , userRole       : user.userRole
                          , userLastLogin  : user.userLastLogin && (new Date(user.userLastLogin))
                          , clients        : []
                          };

        db.all('SELECT * FROM clients WHERE clientUserID=$clientUserID ORDER BY sortOrder', { $clientUserID: user.userID },
               function(err, rows) {
          if (err) return steward.logger.error('database', { event: 'SELECT clients.*', diagnostic: err.message });

          rows.forEach(function(client) {
            var clientUUID = client.clientUID;

            clients[clientUUID] = { clientID         : client.clientID.toString()
                                  , clientUID        : clientUUID
                                  , clientUserID     : user.userID.toString()
                                  , clientName       : client.clientName
                                  , clientComments   : client.clientComments
                                  , clientAuthAlg    : client.clientAuthAlg
                                  , clientAuthParams : JSON.parse(client.clientAuthParams)
                                  , clientAuthKey    : client.clientAuthKey
                                  , clientLastLogin  : client.clientLastLogin && (new Date(client.clientLastLogin))
                                  };

            users[userUUID].clients.push(client.clientID.toString());
          });
        });
      });

      exports.db = db;
    });
  });

  manage.apis.push({ prefix  : '/api/v1/user/create'
                   , route   : create
                   , access  : manage.access.level.write
                   , required : { uuid       : true
                                , name       : true
                                }
                   , optional : { comments   : true
                                , role       : [ 'master', 'resident', 'guest', 'device', 'cloud' ]
                                , clientName : true
                                }
                   , response : {}
                   , comments : [ 'the uuid is specified as the create suffix'
                                ]
                   });
  manage.apis.push({ prefix  : '/api/v1/user/list'
                   , options : { depth: 'flat' }
                   , route   : list
                   , access  : manage.access.level.read
                   , optional : { user       : 'id'
                                , depth      : [ 'flat', 'tree', 'all' ]
                                }
                   , response : {}
                   , comments : [ 'if present, the user is specified as the path suffix' ]
                   });
  manage.apis.push({ prefix  : '/api/v1/user/authenticate'
                   , route   : authenticate
                   , access  : manage.access.level.read
                   , required : { clientID : 'id'
                                , response : true
                                }
                   , response : {}
                   , comments : [ 'the clientID is specified as the path suffix, e.g., .../mrose/1'
                                ]
                   });
};
