import crypto from 'crypto';
import DataLoader from 'dataloader';
import rp from 'request-promise';
import { GrampsError } from '@gramps/errors';

import defaultLogger from './defaultLogger';

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
   * How long to cache GET requests.
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

  /**
   * Executes a request for data from a given URI
   * @param  {string}  uri  the URI to load
   * @param  {object}  options
   * @param  {boolean} options.resolveWithHeaders returns the headers along with the response body
   * @return {Promise}      resolves with the loaded data; rejects with errors
   */
  getRequestData = (uri, options = {}) =>
    new Promise((resolve, reject) => {
      this.logger.info(`Request made to ${uri}`);
      const toHash = `${uri}-${this.headers.Authorization}`;
      const key = crypto
        .createHash('md5')
        .update(toHash)
        .digest('hex');
      const hasCache = this.enableCache && this.getCached(key, resolve, reject);

      this.request(this.getRequestConfig(uri))
        .then(({ headers, body, statusCode }) => {
          const data = options.resolveWithHeaders ? { headers, body } : body;

          // If the data came through alright, cache it.
          if (statusCode === 200) {
            this.addToCache(key, data);
          }

          return data;
        })
        .then(response => !hasCache && resolve(response))
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
    });

  /**
   * Loads an array of URIs
   * @param  {Array}   uris an array of URIs to request data from
   * @return {Promise}      the response from all requested URIs
   */
  load = uris => Promise.all(uris.map(this.getRequestData));

  /**
   * Stores given data in the cache for a set amount of time.
   * @param  {string} key      an MD5 hash of the request URI
   * @param  {object} response the data to be cached
   * @return {object}          the response, unchanged
   */
  addToCache(key, response) {
    if (this.redis && this.enableCache) {
      this.logger.info(`caching response data for ${this.cacheExpiry} seconds`);
      this.redis.setex(key, this.cacheExpiry, JSON.stringify(response));
    }

    return response;
  }

  /**
   * Loads data from the cache, if available.
   * @param  {string}   key       the cache identifier key
   * @param  {function} successCB typically a Promise’s `resolve` function
   * @param  {function} errorCB   typically a Promise’s `reject` function
   * @return {boolean}            true if cached data was found, false otherwise
   */
  getCached(key, successCB, errorCB) {
    if (!this.redis) {
      return;
    }

    this.redis.get(key, (error, data) => {
      if (error) {
        errorCB(error);
      }

      // If we have data, initiate a refetch in the background and return it.
      if (data !== null) {
        this.logger.info('loading data from cache');

        // The success callback will typically resolve a Promise.
        successCB(JSON.parse(data));
        return true;
      }

      return false;
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
