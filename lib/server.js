var phantom = require('phantom')
  , _ = require('lodash')
  , util = require('./util')
  , os = require('os')
  , zlib = require('zlib');

var config = require('config');
var server = module.exports = {};
// var debug = require('debug')('prerender-server');
// var logger = require('./logger')('server');
// var urlParse = require('url').parse;

var PAGE_DONE_CHECK_TIMEOUT = config.page_done_check_timeout || 50;
var RESOURCE_DOWNLOAD_TIMEOUT = config.resource_download_timeout || 10 * 1000;
var WAIT_AFTER_LAST_REQUEST = config.wait_after_last_request || 500;
var JS_CHECK_TIMEOUT = config.js_check_timeout || 50;
var JS_TIMEOUT = config.js_timeout || 15 * 1000;
var EVALUATE_JAVASCRIPT_CHECK_TIMEOUT = config.evaluate_javascript_check_timeout || 50;
var NO_JS_EXECUTION_TIMEOUT = 1000;
var COOKIES_ENABLED = false;
var FOLLOW_REDIRECT = true;

var server = module.exports = {};

server.init = function(options) {
    this.plugins = this.plugins || [];
    this.options = options;

    return this;
};

server.start = function() {
    if(!this.options.isMaster) {
        this.createPhantom();
    }
};

server.use = function(plugin) {
    this.plugins.push(plugin);
    if (typeof plugin.init === 'function') plugin.init(this);
};

server._pluginEvent = function(methodName, args, callback) {
    var _this = this
      , index = 0
      , next;

    next = function() {
        var layer = _this.plugins[index++];
        if (!layer) return callback();

        var method = layer[methodName];

        if (method) {
            method.apply(layer, args);
        } else {
            next();
        }
    };

    args.push(next);
    next();
};

server.createPhantom = function() {
    var _this = this;
    util.log('starting phantom');

    var args = ["--load-images=false", "--ignore-ssl-errors=true", "--ssl-protocol=any", "--web-security=no"];
    var port = this.options.phantomBasePort || 12300;

    if(this.options.phantomArguments) {
        args = this.options.phantomArguments;
    }

    var opts = {
        port: port + this.options.worker.id,
        binary: require('phantomjs').path,
        onExit: function() {
            _this.phantom = null;
            util.log('phantom crashed, restarting...');
            process.nextTick(_.bind(_this.createPhantom, _this));
        }
    };

    if(this.options.onStdout) {
      opts.onStdout = this.options.onStdout;
    }

    if(this.options.onStderr) {
      opts.onStderr = this.options.onStderr;
    }

    args.push(opts);

    args.push(_.bind(this.onPhantomCreate, this));

    phantom.create.apply(this, args);
};

server.onPhantomCreate = function(phantom) {
    util.log('started phantom');
    this.phantom = phantom;
    this.phantom.id = Math.random().toString(36);
};

server.onRequest = function(req, res) {
    var _this = this;

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      var response = {
        hostname: os.hostname()
      };
      res.write(JSON.stringify(response));
      return res.end();
    }

    // Create a partial out of the _send method for the convenience of plugins
    res.send = _.bind(this._send, this, req, res);

    req.prerender = {
        url: util.getUrl(req),
        start: new Date()
    };

    util.log('getting', req.prerender.url);

    this._pluginEvent("beforePhantomRequest", [req, res], function() {
        _this.createPage(req, res);
    });
};

server.createPage = function(req, res) {
    var _this = this;

    if(!this.phantom) {
        setTimeout(function(){
            _this.createPage(req, res);
        }, 50);
    } else {
        req.prerender.phantomId = this.phantom.id;
        this.phantom.createPage(function(page){
            req.prerender.page = page;
            _this.onPhantomPageCreate(req, res);
        });
    }
};

server.onPhantomPageCreate = function(req, res) {
    var _this = this;

    req.prerender.stage = 0;
    req.prerender.pendingRequests = 1;

    this.phantom.set('cookiesEnabled', _this.options.cookiesEnabled || COOKIES_ENABLED);

    // Listen for updates on resource downloads
    req.prerender.page.onResourceRequested(this.onResourceRequested, _.bind(_this.onResourceRequestedCallback, _this, req, res));
    req.prerender.page.set('onResourceReceived', _.bind(_this.onResourceReceived, _this, req, res));
    req.prerender.page.set('onResourceTimeout', _.bind(_this.onResourceTimeout, _this, req, res));

    req.prerender.page.set('viewportSize', { width: 1440, height: 718 });

    req.prerender.page.set('libraryPath', __dirname + '/injections');
    req.prerender.page.set('onInitialized', function(){
      if(!process.env.DISABLE_INJECTION && req.prerender.page) req.prerender.page.injectJs('bind.js');
    });

    req.prerender.page.get('settings.userAgent', function(userAgent) {
        req.prerender.page.set('settings.userAgent', userAgent + ' Prerender (+https://github.com/prerender/prerender)');

        // Fire off a middleware event, then download all of the assets
        _this._pluginEvent("onPhantomPageCreate", [_this.phantom, req, res], function() {
            req.prerender.downloadStarted = req.prerender.lastResourceReceived = new Date();

            req.prerender.downloadChecker = setInterval(function() {
                _this.checkIfPageIsDoneLoading(req, res, req.prerender.status === 'fail');
            }, _this.options.pageDoneCheckTimeout || PAGE_DONE_CHECK_TIMEOUT);

            req.prerender.page.open(encodeURI(req.prerender.url), function(status) {
                req.prerender.status = status;
            });
        });
    });
};

//We want to abort the request if it's a call to Google Analytics or other tracking services.
/*
 * CODE DUPLICATION ALERT
 * Anything added to this if block has to be added to the if block
 * in server.onResourceRequestedCallback.
 * This if statment cannot be broken out into a helper method because
 * this method is serialized across the network to PhantomJS :(
 * Also, PhantomJS doesn't call onResourceError for an aborted request
 */
server.onResourceRequested = function (requestData, request) {
    if ((/google-analytics.com/gi).test(requestData.url) ||
        (/api.mixpanel.com/gi).test(requestData.url) ||
        (/fonts.googleapis.com/gi).test(requestData.url) ||
        (/stats.g.doubleclick.net/gi).test(requestData.url) ||
        (/mc.yandex.ru/gi).test(requestData.url) ||
        (/use.typekit.net/gi).test(requestData.url) ||
        (/beacon.tapfiliate.com/gi).test(requestData.url)){

        request.abort();
    }
};

// Increment the number of pending requests left to download when a new
// resource is requested
/*
 * CODE DUPLICATION ALERT
 * Anything added to this if block has to be added to the if block
 * in server.onResourceRequested.
 * The if statment in onResourceRequested cannot be broken out into a helper method because
 * that method is serialized across the network to PhantomJS :(
 */
server.onResourceRequestedCallback = function (req, res, request) {
    if (!(/google-analytics.com/gi).test(request.url) &&
        !(/api.mixpanel.com/gi).test(request.url) &&
        !(/fonts.googleapis.com/gi).test(request.url) &&
        !(/stats.g.doubleclick.net/gi).test(request.url) &&
        !(/mc.yandex.ru/gi).test(request.url) &&
        !(/use.typekit.net/gi).test(request.url) &&
        !(/beacon.tapfiliate.com/gi).test(request.url)){

        req.prerender.pendingRequests++;
    }
};

// Decrement the number of pending requests left to download after a resource
// is downloaded
server.onResourceReceived = function (req, res, response) {
    req.prerender.lastResourceReceived = new Date();

    //always get the headers off of the first response to pass along
    if(response.id === 1) {
        req.prerender.headers = response.headers;
    }

    //sometimes on redirects, phantomjs doesnt fire the 'end' stage of the original request, so we need to check it here
    if(response.id === 1 && response.status >= 300 && response.status <= 399) {

        if (response.redirectURL) {
            req.prerender.redirectURL = response.redirectURL;
        } else {
            var match = _.findWhere(response.headers, { name: 'Location' });
            if (match) {
                req.prerender.redirectURL = util.normalizeUrl(match.value);
            }
        }

        req.prerender.statusCode = response.status;

        if(!(this.options.followRedirect || FOLLOW_REDIRECT)) {
            util.log('Forcing Response: ', req.prerender.redirectURL);
            //force the response now
            return this.checkIfPageIsDoneLoading(req, res, true);
        }
    }

    if ('end' === response.stage) {
        if(response.url) req.prerender.pendingRequests--;

        if (response.id === 1) {
            req.prerender.pendingRequests--;

            req.prerender.statusCode = response.status;
        }

        if( (this.options.followRedirect || FOLLOW_REDIRECT) && req.prerender.redirectURL && response.id === 1) {
            util.log('end : ', req.prerender.redirectURL);
            req.prerender.statusCode = response.status;
        }
    }
};

// Decrement the number of pending requests to download when there's a timeout
// fetching a resource
server.onResourceTimeout = function(req, res, request) {
    req.prerender.pendingRequests--;
};

// Called occasionally to check if a page is completely loaded
server.checkIfPageIsDoneLoading = function(req, res, force) {
    var timedOut = new Date().getTime() - req.prerender.downloadStarted.getTime() > (this.options.resourceDownloadTimeout || RESOURCE_DOWNLOAD_TIMEOUT)
      , timeSinceLastRequest = new Date().getTime() - req.prerender.lastResourceReceived.getTime();

    // Check against the current stage to make sure we don't finish more than
    // once, and check against a bunch of states that would signal finish - if
    // resource downloads have timed out, if the page has errored out, or if
    // there are no pending requests left
    if(req.prerender.stage < 1 && (force || (req.prerender.status !== null && req.prerender.pendingRequests <= 0 && (timeSinceLastRequest > (this.options.waitAfterLastRequest || WAIT_AFTER_LAST_REQUEST))) || timedOut)) {
        req.prerender.stage = 1;
        clearInterval(req.prerender.downloadChecker);
        req.prerender.downloadChecker = null;

        if(req.prerender.statusCode && req.prerender.statusCode >= 300 && req.prerender.statusCode <= 399) {
            util.log('Redirecting ', req.prerender.url, req.prerender.statusCode);
            // Finish up if we got a redirect status code
            res.send(req.prerender.statusCode);
        } else {
            // Now evaluate the javascript
            req.prerender.downloadFinished = new Date();
            req.prerender.timeoutChecker = setInterval(_.bind(this.checkIfJavascriptTimedOut, this, req, res), (this.options.jsCheckTimeout || JS_CHECK_TIMEOUT));
            this.evaluateJavascriptOnPage(req, res);
        }
    }
};

// Checks to see if the execution of javascript has timed out
server.checkIfJavascriptTimedOut = function(req, res) {

    var timeout = new Date().getTime() - req.prerender.downloadFinished.getTime() > (this.options.jsTimeout || JS_TIMEOUT);
    var lastJsExecutionWasLessThanTwoSecondsAgo = req.prerender.lastJavascriptExecution && (new Date().getTime() - req.prerender.lastJavascriptExecution.getTime() < 5000);
    var noJsExecutionInFirstSecond = !req.prerender.lastJavascriptExecution && (new Date().getTime() - req.prerender.downloadFinished.getTime() > (this.options.noJsExecutionTimeout || NO_JS_EXECUTION_TIMEOUT));

    if (!this.phantom || this.phantom.id !== req.prerender.phantomId) {
        util.log('PhantomJS restarted in the middle of this request. Aborting...');
        clearInterval(req.prerender.timeoutChecker);
        req.prerender.timeoutChecker = null;

        res.send(504);

    } else if (timeout && lastJsExecutionWasLessThanTwoSecondsAgo) {
        util.log('Timed out. Sending request with HTML on the page');
        clearInterval(req.prerender.timeoutChecker);
        req.prerender.timeoutChecker = null;

        this.onPageEvaluate(req, res);
    } else if ((timeout && req.prerender.stage < 2) || noJsExecutionInFirstSecond) {
        util.log('Experiencing infinite javascript loop. Killing phantomjs...');
        clearInterval(req.prerender.timeoutChecker);
        req.prerender.timeoutChecker = null;

        res.send(504, {abort: true});
    }
};

// Evaluates the javascript on the page
server.evaluateJavascriptOnPage = function(req, res) {
    var _this = this;

    if(req.prerender.stage >= 2) return;

    req.prerender.page.evaluate(this.javascriptToExecuteOnPage, function(obj) {
        // Update the evaluated HTML
        req.prerender.documentHTML = obj.html;
        req.prerender.lastJavascriptExecution = new Date();

        if(!obj.shouldWaitForPrerenderReady || (obj.shouldWaitForPrerenderReady && obj.prerenderReady)) {
            clearInterval(req.prerender.timeoutChecker);
            req.prerender.timeoutChecker = null;

            _this.onPageEvaluate(req, res);
        } else {
            setTimeout(_.bind(_this.evaluateJavascriptOnPage, _this, req, res), (this.evaluateJavascriptCheckTimout || EVALUATE_JAVASCRIPT_CHECK_TIMEOUT));
        }
    });
};

// Fetches the html on the page
server.javascriptToExecuteOnPage = function() {
    try {
        var doctype = ''
          , html = document && document.getElementsByTagName('html');

        if(document.doctype) {
            doctype = "<!DOCTYPE "
                 + document.doctype.name
                 + (document.doctype.publicId ? ' PUBLIC "' + document.doctype.publicId + '"' : '')
                 + (!document.doctype.publicId && document.doctype.systemId ? ' SYSTEM' : '')
                 + (document.doctype.systemId ? ' "' + document.doctype.systemId + '"' : '')
                 + '>';
        }

        if (html && html[0]) {
            return {
                html: doctype + html[0].outerHTML,
                shouldWaitForPrerenderReady: typeof window.prerenderReady === 'boolean',
                prerenderReady: window.prerenderReady
            };
        }

    } catch (e) { }

    return  {
        html: '',
        shouldWaitForPrerenderReady: false,
        prerenderReady: window.prerenderReady
    };
};

// Called when we're done evaluating the javascript on the page
server.onPageEvaluate = function(req, res) {

    if(req.prerender.stage >= 2) return;

    req.prerender.stage = 2;

    if (!req.prerender.documentHTML) {
        res.send(req.prerender.statusCode || 404);
    } else {
        this._pluginEvent("afterPhantomRequest", [req, res], function() {
            res.send(req.prerender.statusCode || 200);
        });
    }
};

server._send = function(req, res, statusCode, options) {
    var _this = this;

    if(req.prerender.page) {
        req.prerender.page.close();
        req.prerender.page = null;
    }
    req.prerender.stage = 2;

    req.prerender.documentHTML = options || req.prerender.documentHTML;
    req.prerender.statusCode = statusCode || req.prerender.statusCode;

    if(req.prerender.statusCode) {
        req.prerender.statusCode = parseInt(req.prerender.statusCode);
    }

    if (options && typeof options === 'object' && !Buffer.isBuffer(options)) {
        req.prerender.documentHTML = options.documentHTML;
        req.prerender.redirectURL = options.redirectURL;
    }

    this._pluginEvent("beforeSend", [req, res], function() {

        if (req.prerender.headers && req.prerender.headers.length) {
            req.prerender.headers.forEach(function(header) {
                res.setHeader(header.name, header.value);
            });
        }

        if (req.prerender.redirectURL && !(_this.options.followRedirect || FOLLOW_REDIRECT)) {
            util.log('Redirect URL: ', req.prerender.redirectURL);
            res.setHeader('Location', req.prerender.redirectURL);
        }

        res.setHeader('Content-Type', 'text/html;charset=UTF-8');

        if(req.headers['accept-encoding'] && req.headers['accept-encoding'].indexOf('gzip') >= 0) {
            res.removeHeader('Content-Encoding');
            _this._sendResponse.apply(_this, [req, res, options]);
            // zlib.gzip(req.prerender.documentHTML, function(err, result) {
            // });
        } else {
            res.removeHeader('Content-Encoding');
            _this._sendResponse.apply(_this, [req, res, options]);
        }
    });
};

server._sendResponse = function(req, res, options) {

    if (req.prerender.documentHTML) {
        if(Buffer.isBuffer(req.prerender.documentHTML)) {
            res.setHeader('Content-Length', req.prerender.documentHTML.length);
        } else {
            res.setHeader('Content-Length', Buffer.byteLength(req.prerender.documentHTML, 'utf8'));
        }
    }

    res.setHeader('X-Powered-By', 'Prerender - Webflow');

    res.writeHead(req.prerender.statusCode || 504);
    if (req.prerender.documentHTML) res.write(req.prerender.documentHTML);

    res.end();

    var ms = new Date().getTime() - req.prerender.start.getTime();
    util.log('got', req.prerender.statusCode, 'in', ms + 'ms', 'for', req.prerender.url);

    if(options && options.abort) {
        this._killPhantomJS();
    }

    if(config && config.kill_between_renders) {
        /**
         * Exit phantomJS worker between every render
         *   - Not _killPhantomJS because that sends suicide signal,
         *     which won't spawn a new worker -> hangs the process
         */

        this.options.worker.process.exit();
    }
};

server._killPhantomJS = function() {
    this.options.worker.kill();
       //  try {
       //     //not happy with this... but when phantomjs is hanging, it can't exit any normal way
       //     util.log('pkilling phantomjs');
       //     require('child_process').spawn('pkill', ['phantomjs']);
       //     this.phantom = null;
       // } catch(e) {
       //     util.log('Error killing phantomjs from javascript infinite loop:', e);
       // }
}
