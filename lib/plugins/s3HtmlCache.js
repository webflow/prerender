var cache_manager = require('cache-manager');
var config = require('config');
var debug = require('debug')('prerender-s3HtmlCache');
var AWS = new require('aws-sdk');
var logger = require('../logger')('s3HtmlCache');

var THRESHOLD_BYTES = 250;

AWS.config.update({
  accessKeyId: config.awsAccessKey,
  secretAccessKey: config.awsSecretKey,
  region: 'us-east-1'
});

var s3 = new AWS.S3({ params: { Bucket: config.s3Bucket } });

module.exports = {
    init: function() {
      this.cache = cache_manager.caching({
          store: s3_cache
      });
    },
    beforePhantomRequest: function(req, res, next) {
      if(req.method !== 'GET') {
          return next();
      }

      if(req.headers['cache-control'] === 'no-cache') {
        logger.info('Force cache update %s', req.prerender.url);
        return next();
      }

      this.cache.get(req.prerender.url, function (err, result) {
        if (!err && result) {
          if(result.Expires) {
            if(new Date(result.Expires).getTime() - Date.now() <= 0) {
              debug('Expired cache hit', req.prerender.url);
              logger.info('Expired cache hit', req.prerender.url);
              return next();
            }
          }

          debug('cache hit', req.prerender.url);
          logger.info('cache hit', req.prerender.url);
          req.headers['X-Cache-S3'] = true; // Indicates cache hit to prevent re-caching of the page
          res.send(200, result.Body);
        } else {
          debug('cache miss', req.prerender.url);
          logger.info('cache miss', req.prerender.url);
          next();
        }
      });
    },
    beforeSend: function(req, res, next) {
      if(req.headers['X-Cache-S3']) { // Indicates cache hit, don't re-cache the page
        return next();
      }

      if(typeof req.prerender.documentHTML === 'undefined') { // HTTP Errors
        debug('HTTP Error, document undefined, skipping cache set: %s', req.prerender.url);
        logger.info('HTTP Error, document undefined, skipping cache set: %s', req.prerender.url);
        return next();
      }

      debug('cache set: %s', req.prerender.url);
      logger.info('cache set: %s', req.prerender.url);

      if (req.prerender.documentHTML.length < THRESHOLD_BYTES) {
        logger.warn('Skipping S3 cache setting because HTML suspiciously small! %d bytes - %s', req.prerender.documentHTML, req.prerender.url);
        next();
      }
      else {
        this.cache.set(req.prerender.url, req.prerender.documentHTML, function(err, res) {
          next(); //Wait to call next until after uploaded to s3 to prevent worker from being killed
        });
      }
    }
};


var s3_cache = {
    get: function(key, callback) {
      key = convertKey(key);
      if (process.env.s3_prefix_key) {
        key = process.env.s3_prefix_key + '/' + key;
      }

      s3.getObject({
        Key: key
      }, callback);
    },
    set: function(key, value, callback) {
      key = convertKey(key);
      if (process.env.s3_prefix_key) {
        key = process.env.s3_prefix_key + '/' + key;
      }

      var request = s3.putObject({
        Key: key,
        ContentType: 'text/html;charset=UTF-8',
        StorageClass: 'REDUCED_REDUNDANCY',
        Body: value,
        Expires: config.s3Ttl,
      }, callback);

      if (!callback) {
        request.send();
      }
    }
};

function convertKey(key) {
  return key.replace(/\//g, '-');
}
