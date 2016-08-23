/**
 * Taken (and slightly modified) from https://github.com/kripken/sql.js/issues/91
 */
'use strict';
var lib = require('sql.js');
lib.verbose = function() {
  return lib;
}

lib._Database = lib.Database;
lib.Database = class Db extends lib._Database {
  constructor(filename, mode, cb) {
    let filebuffer;

    if (filename) {
      let fs = require('fs');
      filebuffer = fs.existsSync(filename) ? fs.readFileSync(filename) : undefined;
    }

    super(filebuffer);
    process.nextTick(cb, null);
  }

  // I'm not 100% sure what this was supposed to do on node-sqlite3, heh.
  serialize(cb) {
    process.nextTick(cb);
  }

  run(sql, params, cb) {
    super.run(sql, params);
    var ctx = {};
    if (sql.toLowerCase().indexOf('insert') !== -1) {
      var rez = this.exec("select last_insert_rowid();");
      ctx.lastID = rez[0].values[0][0];
    }
    if (cb) {
      process.nextTick(cb.bind(ctx), null);
    }
    return this;
  }

  all(sql, params, cb) {
    var result = [];
    this.each(sql, params,
    function(r) {
      result.push(r);
    },
    function() {
      cb(null, result);
    });
    return this;
  }

  close () {

  }
}

module.exports = lib;
