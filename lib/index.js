const crypto = require('crypto');
const omit = require('lodash.omit');
const Proto = require('uberproto');
const { NotFound, BadRequest } = require('@feathersjs/errors');
const { select, filterQuery } = require('@feathersjs/commons');
const Ajv = require('ajv');

const { nfcall, getSelect, multiOptions } = require('./utils');

// Create the service.
class Service {
  constructor (options) {
    if (!options) {
      throw new Error('NeDB options have to be provided');
    }

    if (!options.Model) {
      throw new Error('NeDB datastore `Model` needs to be provided');
    }

    this.Model = options.Model;
    this.events = options.events || [];
    this.id = options.id || '_id';
    this.paginate = options.paginate || {};

    if (this.Model.schema) {
      let ajv = new Ajv({ removeAdditional: true, ...options.ajvOptions });
      this.validateCreate = ajv.compile(this.Model.schema);
      this.validatePatch = ajv.compile(Object.assign({}, this.Model.schema, { required: [] }));
    }

    this.addTimestamps = options.addTimestamps;
    this.createdTimestamp = options.createdTimestamp || 'createdAt';
    this.updatedTimestamp = options.updatedTimestamp || 'updatedAt';

    this.find = this.find.bind(this);
    this.get = this.get.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.patch = this.patch.bind(this);
    this.remove = this.remove.bind(this);
  }

  extend (obj) {
    return Proto.extend(obj, this);
  }

  _find (params, count, getFilter = filterQuery) {
    // Start with finding all, and limit when necessary.
    let { filters, query } = getFilter(params.query || {});

    let q = this.Model.find(query);

    // $select uses a specific find syntax, so it has to come first.
    if (filters.$select) {
      q = this.Model.find(query, getSelect(filters.$select));
    }

    // Handle $sort
    if (filters.$sort) {
      q.sort(filters.$sort);
    }

    // Handle $limit
    if (filters.$limit) {
      q.limit(filters.$limit);
    }

    // Handle $skip
    if (filters.$skip) {
      q.skip(filters.$skip);
    }

    let runQuery = total => {
      return nfcall(q, 'exec').then(data => {
        return {
          total,
          limit: filters.$limit,
          skip: filters.$skip || 0,
          data
        };
      });
    };

    if (filters.$limit === 0) {
      runQuery = total => {
        return Promise.resolve({
          total,
          limit: filters.$limit,
          skip: filters.$skip || 0,
          data: []
        });
      };
    }

    if (count) {
      return nfcall(this.Model, 'count', query).then(runQuery);
    }

    return runQuery();
  }

  find (params) {
    const paginate = (params && typeof params.paginate !== 'undefined') ? params.paginate : this.paginate;
    const result = this._find(params, !!paginate.default,
      query => filterQuery(query, paginate));

    if (!paginate.default) {
      return result.then(page => page.data);
    }

    return result;
  }

  _get (id, params) {
    return nfcall(this.Model, 'findOne', { [this.id]: id })
      .then(doc => {
        if (!doc) {
          throw new NotFound(`No record found for id '${id}'`);
        }

        return doc;
      })
      .then(select(params, this.id));
  }

  get (id, params) {
    return this._get(id, params);
  }

  _findOrGet (id, params) {
    if (id === null) {
      return this._find(params).then(page => page.data);
    }

    return this._get(id, params);
  }

  create (raw, params) {
    let validateErrors = null;

    const processRaw = item => {
      if (this.id !== '_id' && item[this.id] === undefined) {
        item = Object.assign({
          [this.id]: crypto.randomBytes(8).toString('hex')
        }, item);
      }

      if (this.addTimestamps) {
        item[this.createdTimestamp] = (new Date()).toISOString();
        item[this.updatedTimestamp] = (new Date()).toISOString();
      }

      if (this.validateCreate) {
        if (!this.validateCreate(item)) {
          validateErrors = validateErrors || [];
          validateErrors.push(...this.validateCreate.errors.map(e => e.message + ' in ' + e.dataPath));
        }
      }

      return item;
    };
    const data = Array.isArray(raw) ? raw.map(processRaw) : processRaw(raw);

    if (validateErrors) {
      throw new Error(`Data failed validation: ${validateErrors.join(', ')}`);
    }

    return nfcall(this.Model, 'insert', data)
      .then(select(params, this.id));
  }

  patch (id, data, params) {
    const { query, options } = multiOptions(id, this.id, params);
    const mapIds = page => page.data.map(current => current[this.id]);

    if (this.addTimestamps) {
      data[this.updatedTimestamp] = (new Date()).toISOString();
    }

    if (this.validatePatch) {
      if (!this.validatePatch(data)) {
        throw new Error(`Data failed validation: ${this.validatePatch.errors.map(e => e.message + ' in ' + e.dataPath).join(', ')}`);
      }
    }

    // By default we will just query for the one id. For multi patch
    // we create a list of the ids of all items that will be changed
    // to re-query them after the update
    const ids = id === null ? this._find(params)
        .then(mapIds) : Promise.resolve([ id ]);

    // Run the query
    return ids
      .then(idList => {
        // Create a new query that re-queries all ids that
        // were originally changed
        const findParams = Object.assign({}, params, {
          query: {
            [this.id]: { $in: idList }
          }
        });
        const updateData = { $set: {} };

        Object.keys(data).forEach(key => {
          if (key.indexOf('$') === 0) {
            updateData[key] = data[key];
          } else if (key !== '_id' && key !== this.id) {
            updateData.$set[key] = data[key];
          }
        });

        return nfcall(this.Model, 'update', query, updateData, options)
          .then(() => this._findOrGet(id, findParams));
      })
      .then(select(params, this.id));
  }

  update (id, data, params) {
    if (Array.isArray(data) || id === null) {
      return Promise.reject(new BadRequest('Not replacing multiple records. Did you mean `patch`?'));
    }

    const { query, options } = multiOptions(id, this.id, params);
    const entry = omit(data, '_id');

    if (this.id !== '_id' || (params.nedb && params.nedb.upsert)) {
      entry[this.id] = id;
    }

    if (this.addTimestamps) {
      entry[this.updatedTimestamp] = (new Date()).toISOString();
    }

    if (this.validateCreate) {
      if (!this.validateCreate(entry)) {
        throw new Error(`Data failed validation: ${this.validateCreate.errors.map(e => e.message + ' in ' + e.dataPath).join(', ')}`);
      }
    }

    return nfcall(this.Model, 'update', query, entry, options)
      .then(() => this._findOrGet(id))
      .then(select(params, this.id));
  }

  remove (id, params) {
    const { query, options } = multiOptions(id, this.id, params);

    return this._findOrGet(id, params).then(items =>
      nfcall(this.Model, 'remove', query, options)
        .then(() => items)
    ).then(select(params, this.id));
  }
}

module.exports = function init (options) {
  return new Service(options);
};

module.exports.Service = Service;
