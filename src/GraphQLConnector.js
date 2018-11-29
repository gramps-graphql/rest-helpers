import crypto from 'crypto';
import DataLoader from 'dataloader';
import rp from 'request-promise';
import { GrampsError } from '@gramps/errors';

import defaultLogger from './defaultLogger';

const REFRESH_CACHE_PREFIX_KEY = 'REFRESH_CACHE_';

/**
 * An abstract class to lay groundwork for data connectors.
 */
export default class GraphQLConnector {
  /**
   * Bluemix requests require a bearer token. This is retrieved by
   * `@console/console-platform-express-session` and stored in `req.user.token`
   * for each Express request. This is passed to the class in the config object
   * for the `GraphQLConnector` constructor.
   * @type {object}
   */
  headers = {};

  /**
   * Set `request-promise` as a class property.
   * @type {RequestPromise}
   */
  request = rp;

  /**
   * How long to cache GET requests by default.
   * @type {number}
   */
  cacheExpiry = 300;

  /**
   * If true, GET requests will be cached for `this.cacheExpiry` seconds.
   * @type {boolean}
   */
  enableCache = true;

  redis = false;

  logger = defaultLogger;

  /**
   * Define required props and create an instance of DataLoader.
   * @constructs GraphQLConnector
   * @param  {object} expressRequest  the request object from Express
   * @return {void}
   */
  constructor() {
    if (new.target === GraphQLConnector) {
      throw new Error('Cannot construct GraphQLConnector classes directly');
    }
  }

  /**
   * Get configuration options for `request-promise`.
   * @param  {string} uri the URI where the request should be sent
   * @return {object}
   */
  getRequestConfig = uri => ({
    uri,
    json: true,
    resolveWithFullResponse: true,
    headers: { ...this.headers },
  });

  isCacheEnabled = options => {
    if (!this.redis || !this.enableCache) {
      return false;
    }
    if (options && options.cacheExpiry === 0) {
      return false;
    }
    return true;
  };

  refreshCache = (uri, options, key) => {
    this.redis.get(`${REFRESH_CACHE_PREFIX_KEY}${key}`, (error, data) => {
      if (data !== 'true') {
        //Key expired, means it's time to refresh cache;
        this.makeRequest(uri, options, key);
      }
    });
  };

  makeRequest = (uri, options, key, resolve, reject = () => {}) => {
    this.logger.info(`Making request to ${this.getShortUri(uri)}`);
    this.request(this.getRequestConfig(uri))
      .then(({ headers, body, statusCode }) => {
        const data = options.resolveWithHeaders ? { headers, body } : body;

        // If the data came through alright, cache it.
        if (statusCode === 200) {
          this.addToCache(key, uri, options, data);
        }

        return data;
      })
      .then(response => resolve && resolve(response))
      .catch(error => {
        const err = GrampsError({
          error,
          description: `There was an error with the query: ${error.message}`,
          docsLink: 'https://ibm.biz/graphql',
          errorCode: 'GRAPHQL_QUERY_ERROR',
          graphqlModel: this.constructor.name,
          targetEndpoint: uri,
        });
        reject(err);
      });
  };

  /**
   * Executes a request for data from a given URI
   * @param  {string}  uri  the URI to load
   * @param  {object}  options
   * @param  {boolean} options.resolveWithHeaders returns the headers along with the response body
   * @param  {number}  options.cacheExpiry: number of seconds to cache this API request instead of using default expiration.
   *                                        Passing in 0 indicates you want this to NOT get cached at all
   * @param  {number}  options.cacheRefresh: If this is passed in, number of seconds that must elapse before the GET uri is called
   *                                         to update the cache for this API. By default, it gets called every time, but if data rarely changes and
   *                                         it is an expensive API call, you have the option to return the cache and exit.
   * @return {Promise}      resolves with the loaded data; rejects with errors
   */
  getRequestData = (uri, options = {}) =>
    new Promise((resolve, reject) => {
      const toHash = `${uri}-${this.headers.Authorization}`;
      const key = crypto
        .createHash('md5')
        .update(toHash)
        .digest('hex');
      const hasCache = this.isCacheEnabled(options);

      if (hasCache) {
        const redisPromise = new Promise(redisResolve => {
          this.getCached(key, redisResolve, reject);
        }).then(result => {
          if (!result) {
            //Not found in cache, proceed to make the request
            this.makeRequest(uri, options, key, resolve, reject);
            return;
          }
          if (options && options.cacheRefresh > 0) {
            //We have specified that we only want to refresh the cache conditionally, so we will check if it's time to do so
            this.refreshCache(uri, options, key);
            resolve(result); //Found in cache, resolve right away with cached result
            return;
          }
          this.makeRequest(uri, options, key, null, reject); //we already resolved, now just make request to refresh cache
          resolve(result); //Found in cache, resolve right away with cached result
        });
      } else {
        this.makeRequest(uri, options, key, resolve, reject);
      }
    });

  /**
   * Loads an array of URIs
   * @param  {Array}   uris an array of URIs to request data from
   * @return {Promise}      the response from all requested URIs
   */
  load = uris => Promise.all(uris.map(this.getRequestData));

  getShortUri = uri => uri.split('?')[0];

  getCustomOptions = options => {
    let expiry = this.cacheExpiry;
    let setCustomRefresh = false;
    let setCache = true;
    if (options.cacheExpiry === 0) {
      setCache = false;
    } else if (options.cacheExpiry > 0) {
      expiry = options.cacheExpiry;
    }
    if (options.cacheRefresh > 0) {
      setCustomRefresh = options.cacheRefresh;
    }
    return { expiry, setCustomRefresh, setCache };
  };

  /**
   * Stores given data in the cache for a set amount of time.
   * @param  {string} key      an MD5 hash of the request URI
   * @param  {object} response the data to be cached
   * @return {object}          the response, unchanged
   */
  addToCache(key, uri, options, response) {
    if (!this.enableCache) {
      return;
    }
    const { expiry, setCustomRefresh, setCache } = this.getCustomOptions(
      options,
    );
    if (setCache === false) {
      return; //cache is set to 0, so do not store to cache
    }
    if (setCustomRefresh !== false) {
      //Custom refresh is set to true, save a redix key that indicates while present we do not want to call the api and refresh cache
      this.redis.setex(
        `${REFRESH_CACHE_PREFIX_KEY}${key}`,
        setCustomRefresh,
        'true',
      );
    }
    const shortUri = this.getShortUri(uri);
    this.logger.info(
      `caching response data for ${shortUri} for ${expiry} seconds`,
    );
    this.redis.setex(key, expiry, JSON.stringify(response));
  }

  /**
   * Loads data from the cache, if available.
   * @param  {string}   key       the cache identifier key
   * @param  {function} successCB typically a Promise's `resolve` function
   * @param  {function} errorCB   typically a Promise's `reject` function
   * @return {boolean}            true if cached data was found, false otherwise
   */
  getCached(key, successCB, errorCB) {
    this.redis.get(key, (error, data) => {
      if (error) {
        errorCB(error);
      }

      // If we have data, initiate a refetch in the background and return it.
      if (data !== null) {
        this.logger.info('loading data from cache');

        // The success callback will typically resolve a Promise.
        successCB(JSON.parse(data));
      } else {
        successCB(null);
      }
    });
  }

  /**
   * Configures and sends a GET request to a REST API endpoint.
   * @param  {string}  endpoint the API endpoint to send the request to
   * @param  {object}  options   optional configuration for the request
   * @return {Promise}          Promise that resolves with the request result
   */
  get(endpoint, options) {
    this.createLoader();

    // If additional options are needed, we bypass the dataloader
    if (options) {
      return this.getRequestData(`${this.apiBaseUri}${endpoint}`, options);
    }

    return this.loader.load(`${this.apiBaseUri}${endpoint}`);
  }

  /**
   * Helper method for sending non-cacheable requests.
   *
   * @see https://github.com/request/request-promise
   *
   * @param  {string}  endpoint  the API endpoint to hit
   * @param  {string}  method    the HTTP request method to use
   * @param  {object}  options   config options for request-promise
   * @return {Promise}           result of the request
   */
  mutation(endpoint, method, options) {
    const config = {
      // Start with our baseline configuration.
      ...this.getRequestConfig(`${this.apiBaseUri}${endpoint}`),

      // Add some PUT-specific options.
      method,

      // Allow the caller to override options.
      ...options,
    };

    return this.request(config);
  }

  /**
   * Configures the muation options to correctly set request headers
   * @param  {object} body     optional body to be sent with the request
   * @param  {object} options  optional configuration for request-promise
   * @return {object}          complete request-promise configuration
   */
  getMutationOptions(body, options) {
    const { formData } = options;

    // If there's formData, we omit the body to have the Content-Type header
    // for file uploads set automatically by request-promise
    if (formData) {
      return {
        ...options,
      };
    }

    // Otherwise, we return the body along with any other options
    return {
      body,
      ...options,
    };
  }

  /**
   * Configures and sends a POST request to a REST API endpoint.
   * @param  {string} endpoint the API endpoint to send the request to
   * @param  {object} body     optional body to be sent with the request
   * @param  {object} options  optional configuration for request-promise
   * @return {Promise}         Promise that resolves with the request result
   */
  post(endpoint, body = {}, options = {}) {
    const mutationOptions = this.getMutationOptions(body, options);

    return this.mutation(endpoint, 'POST', mutationOptions);
  }

  /**
   * Configures and sends a PUT request to a REST API endpoint.
   * @param  {string} endpoint the API endpoint to send the request to
   * @param  {object} body     optional body to be sent with the request
   * @param  {object} options  optional configuration for request-promise
   * @return {Promise}         Promise that resolves with the request result
   */
  put(endpoint, body = {}, options = {}) {
    const mutationOptions = this.getMutationOptions(body, options);

    return this.mutation(endpoint, 'PUT', mutationOptions);
  }

  /**
   * Configures and sends a PATCH request to a REST API endpoint.
   * @param  {string} endpoint the API endpoint to send the request to
   * @param  {object} body     optional body to be sent with the request
   * @param  {object} options  optional configuration for request-promise
   * @return {Promise}         Promise that resolves with the request result
   */
  patch(endpoint, body = {}, options = {}) {
    const mutationOptions = this.getMutationOptions(body, options);

    return this.mutation(endpoint, 'PATCH', mutationOptions);
  }

  /**
   * Configures and sends a DELETE request to a REST API endpoint.
   * @param  {string} endpoint the API endpoint to send the request to
   * @param  {object} options  optional configuration for request-promise
   * @return {Promise}         Promise that resolves with the request result
   */
  delete(endpoint, options = {}) {
    return this.mutation(endpoint, 'DELETE', {
      ...options,
    });
  }

  createLoader() {
    // We can enable batched queries later on, which may be more performant.
    this.loader = new DataLoader(this.load, {
      batch: false,
    });
  }
}
