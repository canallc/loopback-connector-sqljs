var async = require('async');
module.exports = mixinMigration;

function mixinMigration(SQLiteDB) {

  function mapSQLiteDatatypes(typeName) {
    return typeName;
  }

  /*!
   * Discover the properties from a table
   * @param {String} model The model name
   * @param {Function} cb The callback function
   */
  function getTableStatus(model, cb) {
    function decoratedCallback(err, data) {
      if (err) {
        console.error(err);
      }
      if (!err) {
        data.forEach(function (field) {
          field.type = mapSQLiteDatatypes(field.type);
        });
      }
      cb(err, data);
    }

    var sql = null;
    sql = 'PRAGMA table_info(' + this.tableEscaped(model) +')';
    var params = [];
    params.status = true;
    this.executeSQL(sql, params, decoratedCallback);
  }

  /**
   * Perform autoupdate for the given models
   * @param {String[]} [models] A model name or an array of model names. If not present, apply to all models
   * @callback {Function} [callback] The callback function
   * @param {String|Error} err The error string or object
   */
  SQLiteDB.prototype.autoupdate = function(models, cb) {
    var self = this;
    if ((!cb) && ('function' === typeof models)) {
      cb = models;
      models = undefined;
    }
    // First argument is a model name
    if ('string' === typeof models) {
      models = [models];
    }

    models = models || Object.keys(this._models);

    async.each(models, function(model, done) {
      if (!(model in self._models)) {
        return process.nextTick(function() {
          done(new Error('Model not found: ' + model));
        });
      }
      getTableStatus.call(self, model, function(err, fields) {
        if (!err && fields.length) {
          self.alterTable(model, fields, done);
        } else {
          self.createTable(model, done);
        }
      });
    }, cb);
  };

  /*!
   * Check if the models exist
   * @param {String[]} [models] A model name or an array of model names. If not present, apply to all models
   * @param {Function} [cb] The callback function
   */
  SQLiteDB.prototype.isActual = function(models, cb) {
    var self = this;

    if ((!cb) && ('function' === typeof models)) {
      cb = models;
      models = undefined;
    }
    // First argument is a model name
    if ('string' === typeof models) {
      models = [models];
    }

    models = models || Object.keys(this._models);

    var changes = [];
    async.each(models, function(model, done) {
      getTableStatus.call(self, model, function(err, fields) {
        changes = changes.concat(getAddModifyColumns.call(self, model, fields));
        changes = changes.concat(getDropColumns.call(self, model, fields));
        done(err);
      });
    }, function done(err) {
      if (err) {
        return cb && cb(err);
      }
      var actual = (changes.length === 0);
      cb && cb(null, actual);
    });
  };

  /*!
   * Alter the table for the given model
   * @param {String} model The model name
   * @param {Object[]} actualFields Actual columns in the table
   * @param {Function} [cb] The callback function
   */
  SQLiteDB.prototype.alterTable = function (model, actualFields, cb) {
    var self = this;
    var pendingChanges = getAddModifyColumns.call(self, model, actualFields);
    if (pendingChanges.length > 0) {
      applySqlChanges.call(self, model, pendingChanges, function (err, results) {
        var dropColumns = getDropColumns.call(self, model, actualFields);
        if (dropColumns.length > 0) {
          applySqlChanges.call(self, model, dropColumns, cb);
        } else {
          cb && cb(err, results);
        }
      });
    } else {
      var dropColumns = getDropColumns.call(self, model, actualFields);
      if (dropColumns.length > 0) {
        applySqlChanges.call(self, model, dropColumns, cb);
      } else {
        cb && process.nextTick(cb.bind(null, null, []));
      }
    }
  };

  function getAddModifyColumns(model, actualFields) {
    var sql = [];
    var self = this;
    sql = sql.concat(getColumnsToAdd.call(self, model, actualFields));
    var drops = getPropertiesToModify.call(self, model, actualFields);
    if (drops.length > 0) {
      if (sql.length > 0) {
        sql = sql.concat(', ');
      }
      sql = sql.concat(drops);
    }
    // sql = sql.concat(getColumnsToDrop.call(self, model, actualFields));
    return sql;
  }

  function getDropColumns(model, actualFields) {
    var sql = [];
    var self = this;
    // sql = sql.concat(getColumnsToDrop.call(self, model, actualFields));
    return sql;
  }

  function getColumnsToAdd(model, actualFields) {
    var self = this;
    var m = self._models[model];
    var propNames = Object.keys(m.properties);
    var sql = [];
    propNames.forEach(function (propName) {
      if (self.id(model, propName)) return;
      var found = searchForPropertyInActual.call(self, model, self.column(model, propName), actualFields);

      if (!found && propertyHasNotBeenDeleted.call(self, model, propName)) {
        sql.push('ADD COLUMN ' + addPropertyToActual.call(self, model, propName));
      }
    });

    return sql;
  }

  function propertyHasNotBeenDeleted(model, propName) {
    return !!this._models[model].properties[propName];
  }

  function addPropertyToActual(model, propName) {
    var self = this;
    var sqlCommand = self.columnEscaped(model, propName) + ' ' +
      self.columnDataType(model, propName) + (propertyCanBeNull.call(self, model, propName) ? "" : " NOT NULL");
    return sqlCommand;
  }

  function searchForPropertyInActual(model, propName, actualFields) {
    var self = this;
    var found = false;
    actualFields.forEach(function (f) {
      if (f.column === self.column(model, propName)) {
        found = f;
        return;
      }
    });
    return found;
  }

  function getPropertiesToModify(model, actualFields) {
    var self = this;
    var sql = [];
    var m = self._models[model];
    var propNames = Object.keys(m.properties);
    var found;
    propNames.forEach(function (propName) {
      if (self.id(model, propName)) {
        return;
      }
      found = searchForPropertyInActual.call(self, model, propName, actualFields);
      if (found && propertyHasNotBeenDeleted.call(self, model, propName)) {
        if (datatypeChanged(propName, found)) {
          sql.push('ALTER COLUMN ' + modifyDatatypeInActual.call(self, model, propName));
        }
        if (nullabilityChanged(propName, found)) {
          sql.push('ALTER COLUMN' + modifyNullabilityInActual.call(self, model, propName));
        }
      }
    });

    if (sql.length > 0) {
      sql = [sql.join(', ')];
    }

    return sql;

    function datatypeChanged(propName, oldSettings) {
      var newSettings = m.properties[propName];
      if (!newSettings) {
        return false;
      }
      return oldSettings.type.toUpperCase() !== self.columnDataType(model, propName);
    }

    function isNullable(p) {
      return !(p.required ||
        p.id ||
        p.allowNull === false ||
        p.null === false ||
        p.nullable === false);
    }

    function nullabilityChanged(propName, oldSettings) {
      var newSettings = m.properties[propName];
      if (!newSettings) {
        return false;
      }
      var changed = false;
      if (oldSettings.nullable === 'YES' && !isNullable(newSettings)) {
        changed = true;
      }
      if (oldSettings.nullable === 'NO' && isNullable(newSettings)) {
        changed = true;
      }
      return changed;
    }
  }

  function modifyDatatypeInActual(model, propName) {
    var self = this;
    var sqlCommand = self.columnEscaped(model, propName) + ' TYPE ' +
      self.columnDataType(model, propName);
    return sqlCommand;
  }

  function modifyNullabilityInActual(model, propName) {
    var self = this;
    var sqlCommand = self.columnEscaped(model, propName) + ' ';
    if (propertyCanBeNull.call(self, model, propName)) {
      sqlCommand = sqlCommand + "DROP ";
    } else {
      sqlCommand = sqlCommand + "SET ";
    }
    sqlCommand = sqlCommand + "NOT NULL";
    return sqlCommand;
  }

  function getColumnsToDrop(model, actualFields) {
    var self = this;
    var sql = [];
    actualFields.forEach(function (actualField) {
      if (self.idColumn(model) === actualField.column) {
        return;
      }
      if (actualFieldNotPresentInModel(actualField, model)) {
        sql.push('DROP COLUMN ' + self.escapeName(actualField.column));
      }
    });
    if (sql.length > 0) {
      sql = [sql.join(', ')];
    }
    return sql;

    function actualFieldNotPresentInModel(actualField, model) {
      return !(self.propertyName(model, actualField.column));
    }
  }

  function applySqlChanges(model, pendingChanges, cb) {
    var self = this;
    if (pendingChanges.length) {
      var changesPrefix = 'ALTER TABLE ' + self.tableEscaped(model);
      var done = 0;
      var globalRes = [];
      pendingChanges.forEach(function (change) {
        self.query(changesPrefix + ' ' + change, function (err, res) {
          globalRes.push(res);
          if (++done === pendingChanges.length) {
            cb && cb(err ? err : null, globalRes);
          }
        });
      });
    }
  }


  /*!
   * Build a list of columns for the given model
   * @param {String} model The model name
   * @returns {String}
   */
   SQLiteDB.prototype.buildColumnDefinitions = SQLiteDB.prototype.propertiesSQL = function (model) {
    var self = this;
    var sql = [];
    var pks = this.idNames(model).map(function (i) {
      return self.columnEscaped(model, i);
    });
    Object.keys(this._models[model].properties).forEach(function (prop) {
      var colName = self.columnEscaped(model, prop);
      sql.push(colName + ' ' + self.buildColumnDefinition(model, prop));
    });
    if (pks.length > 0) {
      sql.push('PRIMARY KEY(' + pks.join(',') + ')');
    }
    return sql.join(',\n  ');
  };

  /*!
   * Build settings for the model property
   * @param {String} model The model name
   * @param {String} propName The property name
   * @returns {*|string}
   */
  SQLiteDB.prototype.buildColumnDefinition = function (model, propName) {
    var self = this;
    if (this.id(model, propName) && this._models[model].properties[propName].generated) {
      return 'INTEGER';
    }
    var result = self.columnDataType(model, propName);
    if (!propertyCanBeNull.call(self, model, propName)) result = result + ' NOT NULL';

    result += self.columnDbDefault(model, propName);
    return result;
  };

  /*!
   * Get the database-default value for column from given model property
   *
   * @param {String} model The model name
   * @param {String} property The property name
   * @returns {String} The column default value
   */
  SQLiteDB.prototype.columnDbDefault = function(model, property) {
    var columnMetadata = this.columnMetadata(model, property);
    var colDefault = columnMetadata && columnMetadata.dbDefault;

    return colDefault ? (' DEFAULT ' + columnMetadata.dbDefault): '';
  };

  SQLiteDB.prototype.mapToDB = function (model, data) {
    var dbData = {};
    if (!data) {
      return dbData;
    }
    var props = this._models[model].properties;
    for (var p in data) {
      if(props[p]) {
        var pType = props[p].type && props[p].type.name;
        if (pType === 'GeoPoint' && data[p]) {
          dbData[p] = '(' + data[p].lat + ',' + data[p].lng + ')';
        } else if (pType === 'Date' && data[p]) {
          dbData[p] = data[p].getTime() || 0;
        } else {
          dbData[p] = data[p];
        }
      }
    }
    return dbData;
  };

  /*!
   * Find the column type for a given model property
   *
   * @param {String} model The model name
   * @param {String} property The property name
   * @returns {String} The column type
   */
  SQLiteDB.prototype.columnDataType = function (model, property) {
    var columnMetadata = this.columnMetadata(model, property);
    var colType = columnMetadata && columnMetadata.dataType;
    if (colType) {
      colType = colType.toUpperCase();
    }
    var prop = this._models[model].properties[property];
    if (!prop) {
      return null;
    }
    var colLength = columnMetadata && columnMetadata.dataLength || prop.length;
    if (colType) {
      return colType + (colLength ? '(' + colLength + ')' : '');
    }

    switch (prop.type.name) {
      default:
      case 'String':
      case 'JSON':
        return 'TEXT';
      case 'Text':
        return 'TEXT';
      case 'Number':
        return 'INTEGER';
      case 'Date':
        return 'DATETIME';
      case 'Timestamp':
        return 'DATETIME';
      case 'GeoPoint':
      case 'Point':
        return 'POINT';
      case 'Boolean':
        return 'BOOLEAN';
    }
  };

  function propertyCanBeNull(model, propName) {
    var p = this._models[model].properties[propName];
    if (p.required || p.id) {
      return false;
    }
    return !(p.allowNull === false ||
      p['null'] === false || p.nullable === false);
  }

}
