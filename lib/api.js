var Promise = require('bluebird');
var fs = require('fs');
var Schema = require('protobuf').Schema;
var request = Promise.promisifyAll(require('request'));
var util = require('util');
var fmt = util.format;
var _ = require('lodash');
var assert = require('assert');
var qs = require('querystring');
var stringify = require('json-stable-stringify');

function getOrElseThrow(thing, msg) {
  if (typeof thing === 'undefined') {
    throw new Error(msg);
  }
}
_.mixin({'getOrElseThrow': getOrElseThrow});

function LoginError(msg) {
  Error.call(this);
  Error.captureStackTrace(this, arguments.callee);
  this.message = msg;
  this.name = 'LoginError';
}

LoginError.prototype = Object.create(Error.prototype);
LoginError.prototype.constructor = LoginError;

function RequestError(msg) {
  Error.call(this);
  Error.captureStackTrace(this, arguments.callee);
  this.message = msg;
  this.name = 'RequestError';
}

RequestError.prototype = Object.create(Error.prototype);
RequestError.prototype.constructor = RequestError;

/**
 * Parsed string into object.
 * @param {String} lines - e.g., "FOO=bar\nBAZ=foo"
 * @return {Object} parsed object result, e.g., {foo: "bar", baz: "foo"}
 */
function responseToObj(lines) {
  return _.chain(lines.split('\n')).reduce(function (obj, line) {
    var pair = line.split('=');
    assert(pair.length == 2, 'expected list of pairs from server');
    var key = pair[0].toLowerCase();
    var val = pair[1];
    obj[key] = val;
    return obj;
  }, {}).value();
}


/**
 * GooglePlay API
 * @todo todo Consider allowing passing in Device configuration information to
 * configure user-agent etc.
 * @param {String} username - required
 * @param {String} password - required
 * @param {String} androidId - required
 * @param {Boolean} useCache - enable debug output (default: true)
 * @param {Boolean} debug - enable debug output (default: false)
 * @return {type}
 */
var GooglePlay = (function GooglePlay(username, password, androidId, useCache, debug) {
  // default for args:
  androidId = androidId || null;
  debug = debug === true;

  var USE_CACHE = (useCache === true);
  var authToken;

  if (debug) {
    require('request-debug')(request);
  }

  _.getOrElseThrow(username, 'Require username');
  _.getOrElseThrow(password, 'Require password');
  _.getOrElseThrow(androidId, 'Require Android ID');

  var DEVICE_COUNTRY, OPERATOR_COUNTRY, LOGIN_LANGUAGE;
  DEVICE_COUNTRY = LOGIN_LANGUAGE = OPERATOR_COUNTRY = "us";

  // Various constants used for requests:
  // TODO: consider using a single object to hold these values?
  var SERVICE = "androidmarket";
  var URL_LOGIN = "https://android.clients.google.com/auth";
  var ACCOUNT_TYPE_GOOGLE = "GOOGLE";
  var ACCOUNT_TYPE_HOSTED = "HOSTED";
  var ACCOUNT_TYPE_HOSTED_OR_GOOGLE = "HOSTED_OR_GOOGLE";
  var SDK_VERSION = "16";
  var UNSUPPORTED_EXPERIMENTS = [
    "nocache:billing.use_charging_poller",
    "market_emails", "buyer_currency", "prod_baseline",
    "checkin.set_asset_paid_app_field", "shekel_test", "content_ratings",
    "buyer_currency_in_app", "nocache:encrypted_apk", "recent_changes"
  ];
  var ENABLED_EXPERIMENTS = [
     "cl:billing.select_add_instrument_by_default"
  ];
  var CLIENT_ID = "am-android-google";
  // TODO: denormalize this a bit to allow greater configurability?
  var USER_AGENT = "Android-Finsky/4.3.11 " +
    "(api=3,versionCode=80230011,sdk=17,device=toro,hardware=tuna,product=mysid)";
  var ACCEPT_LANGUAGE = "en_US";
  var ANDROID_VENDING = "com.android.vending";
  var DOWNLOAD_MANAGER_USER_AGENT = "AndroidDownloadManager/4.2.2 (Linux; U; Android 4.2.2; Galaxy Nexus Build/JDQ39)";
  // END CONSTANTS

  var CACHE_INVALIDATION_INTERVAL = 30000;

  // protobuf initialization
  var schema = new Schema(fs.readFileSync('./lib/gen/googleplay.desc'));
  var ResponseWrapper = schema.ResponseWrapper;
  var PreFetch = schema.PreFetch;

  /**
   * Login to Google API
   * @todo todo
   * @param {String} username
   * @param {String} password
   */
  function login() {
    if (typeof username === 'undefined' || typeof password === 'undefined') {
      if (typeof authToken === 'undefined') {
        throw new Error("You must provide a username and password or set the auth token.");
      }
    }

    var body = {
      "Email": username,
      "Passwd": password,
      "service": SERVICE,
      "accountType": ACCOUNT_TYPE_HOSTED_OR_GOOGLE,
      "has_permission": "1",
      "source": "android",
      "androidId": androidId,
      "app": ANDROID_VENDING,
      "device_country": DEVICE_COUNTRY,
      "operatorCountry": OPERATOR_COUNTRY,
      "lang": LOGIN_LANGUAGE,
      "sdk_version": SDK_VERSION
    };

    return request.postAsync({url: URL_LOGIN, gzip: true, json: false, form: body})
    .spread(function (res, body) {
      if (res.statusCode !== 200) {
        throw new LoginError(body);
      }
      assert(res.statusCode === 200, 'login failed');
      assert(res.headers['content-type'] === 'text/plain; charset=utf-8', 'utf8 string body');
      var response = responseToObj(body);
      if (!response || !response.auth) {
        throw new Error('expected auth in server response');
      }

      // set the auth token member to the response token.
      authToken = response.auth;
    });
  }

  /**
   * Assist with request memoization by resolving a combination of request
   * fields to a cached Promise when possible. Only tested for HTTP GET
   * requests.
   * @todo support post requests as well?
   * @param {String} path
   * @param {Object} query
   * @param {String} datapost - data for POST requests.
   */
  function cachedGetResolver(path, query, datapost) {
    // ensure all fields in query are strings
    // assert(typeof datapost === 'undefined' || datapost === false, "only support POST atm");
    query = _.reduce(query, function (aux, v, k) {
      aux[k] = v.toString();
      return aux;
    }, {});
    var cacheKey = fmt("%s|%s|post=%s", path, stringify(query), datapost);
    return cacheKey;
  }

  /**
   * Internal function to execute requests against the google play API (version 2).
   * Responds in the form of a Buffer.
   * @return {Promise} Promise of a Buffer object.
   */
  function _executeRequestApi2(path, query, datapost, contentType) {
    assert(typeof authToken !== 'undefined', 'need auth token');
    assert(typeof path !== 'undefined', 'need path');
    contentType = contentType || "application/x-www-form-urlencoded; charset=UTF-8";

    var headers = {
      "Accept-Language": ACCEPT_LANGUAGE,
      "Authorization": fmt("GoogleLogin auth=%s", authToken),
      "X-DFE-Enabled-Experiments": ENABLED_EXPERIMENTS.join(","),
      "X-DFE-Unsupported-Experiments": UNSUPPORTED_EXPERIMENTS.join(","),
      "X-DFE-Device-Id": androidId,
      "X-DFE-Client-Id": CLIENT_ID,
      "User-Agent": USER_AGENT,
      "X-DFE-SmallestScreenWidthDp": "320",
      "X-DFE-Filter-Level": "3",
      "Host": "android.clients.google.com" // TODO: is this needed?
    };

    var url = fmt("https://android.clients.google.com/fdfe/%s", path);

    function handleRequest() {
      function postRequest() {
        headers['Content-Type'] = contentType;
        return request.postAsync({
          url: url, qs: query, headers: headers, body: datapost,
          json: false, gzip: false,
          encoding: null // body should be raw Buffer
        });
      }
      function getRequest() {
        return request.getAsync({
          url: url, qs: query, headers: headers,
          json: false, gzip: false,
          encoding: null // body should be raw Buffer
        });
      }
      if (datapost) {
        return postRequest();
      }
      return getRequest();
    }

    return handleRequest().spread(function (res, body) {
      if (res.statusCode !== 200) {
        throw new RequestError(body.toString());
      }
      assert(res.statusCode === 200, 'http status code');
      assert(res.headers['content-type'] === 'application/x-gzip', 'not application/x-gzip response');
      assert(Buffer.isBuffer(body), "expect Buffer body");
      return body;
    });
  }

 var memoizedExecuteRequestApi2 = USE_CACHE ?
   _.memoize(_executeRequestApi2, cachedGetResolver) : _executeRequestApi2;

  /**
   * Insert preFetch data into cache to save us from some future requests.
   * @param {ResponseWrapper} response - the server response from which try and
   * cache preFetch fields.
   */
  function _tryHandlePrefetch(response, ttl) {
    if (!response.preFetch) {
      return;
    }
    response.preFetch.forEach(function (entry) {
      var match = /(.*)\?(.*)/.exec(entry.url);
      if (match) {
        var path = match[1];
        var query = qs.parse(match[2]);
        var cacheKey = cachedGetResolver(path, query, false);
        assert(typeof memoizedExecuteRequestApi2.cache !== 'undefined', "undefined cache");
        assert(typeof entry.response !== 'undefined', "need defined response to cache");
        if (memoizedExecuteRequestApi2[cacheKey]) {
          return;
        }

        memoizedExecuteRequestApi2.cache[cacheKey] = Promise.resolve(entry.response);
        if (ttl) {
          setTimeout(function () {
            if (debug) {
              console.log('invalidating cache key: %s', cacheKey);
            }
            delete memoizedExecuteRequestApi2.cache[cacheKey];
          }, ttl);
        }
      }
    });
  }
  /**
   * Convert a data buffer to a ResponseWrapper object.
   * @param {Buffer} data
   */
  function _toResponseWrapper(data) {
    return ResponseWrapper.parse(data);
  }

  /**
   * Main API request handler. If server returns preFetch fields, cache them to
   * save on future requests.
   * @param {String} path
   * @param {Object} query
   * @param {String} datapost - data for POST requests.
   * @param {String} contentType - override content-type header.
   * @return {Promise} promise of a ResponseWrapper object.
   */
  function executeRequestApi(path, query, datapost, contentType) {
    return memoizedExecuteRequestApi2(path, query, datapost, contentType)
    .then(function (body) {
      var message = _toResponseWrapper(body);
      assert(typeof message !== 'undefined', "empty response");
      if (USE_CACHE) {
        _tryHandlePrefetch(message, CACHE_INVALIDATION_INTERVAL);
      }
      return message;
    });
  }


  function getPackageDetails(pkg) {
    return executeRequestApi('details', {doc: pkg}).then(function (res) {
      return res.payload.detailsResponse.docV2;
    });
  }

  function getRelatedApps(pkg) {
    return executeRequestApi('rec', {doc: pkg, rt: "1", c: "3"}).then(function (res) {
      assert(res.payload.listResponse, "expected response");
      assert(res.payload.listResponse.doc, "expected doc");
      return res.payload.listResponse.doc;
    });
  }

  /**
   * Get URL and cookie info for downloading a file from Google.
   * @param {String} pkg
   * @param {Integer} versionCode
   */
  function getDownloadInfo(pkg, versionCode) {
    var body = fmt("ot=1&doc=%s&vc=%d", pkg, versionCode);
    return executeRequestApi('purchase', {}, body).then(function (res) {
      assert(res.payload.buyResponse, "expected buy response");
      assert(res.payload.buyResponse.purchaseStatusResponse, "expected purchaseStatusResponse");
      var purchaseStatusResponse = res.payload.buyResponse.purchaseStatusResponse;
      var ret = {
        url: purchaseStatusResponse.appDeliveryData.downloadUrl,
        cookies: purchaseStatusResponse.appDeliveryData.downloadAuthCookie
      };
      return ret;
    });
  }

  /**
   * Return a request cookie jar.
   * @param {String} url
   * @param {Array} cookies - array of {name: "...", value: "..."} objects.
   */
  function _prepCookies(url, cookies) {
    return _.chain(cookies).reduce(function(jar, cookie) {
      assert(typeof cookie === 'object', "expected cookie object");
      assert(typeof cookie.name === 'string', "expected cookie name string");
      assert(typeof cookie.value === 'string', "expected cookie value string");
      var asStr = fmt("%s=%s", cookie.name, cookie.value);
      jar.setCookie(request.cookie(asStr), url);
      return jar;
    }, request.jar()).value();
  }


  /**
   * Download a specific package, at a specific versionCode.
   */
  function downloadApk(pkg, versionCode) {
    var headers = {
      "User-Agent": DOWNLOAD_MANAGER_USER_AGENT
    };
    return getDownloadInfo(pkg, versionCode)
    .then(function (res) {
      var url = res.url;
      var cookieJar = _prepCookies(res.cookies);
      return request.getAsync({url: url, jar: cookieJar, headers: headers});
    });
  }

  /**
   * Download the latest APK from the play store.
   */
  function downloadLatestApk(pkg) {
    // get the details for the package, use versionCode and then call downloadApk
  }


  function cachedKeys() {
    return _.keys(memoizedExecuteRequestApi2.cache);
  }

  function invalidateCache() {
    if (debug) {
      console.log('invalidating cache');
      console.log('old keys: %s', cachedKeys());
    }
    memoizedExecuteRequestApi2.cache.each(function (v, k) {
      delete cache[k];
    });

    if (debug) {
      console.log('now keys: %s', cachedKeys());
    }
  }

  return {
    login: login,
    executeRequestApi: executeRequestApi,
    details : getPackageDetails,
    related: getRelatedApps,
    getDownloadInfo: getDownloadInfo,
    download: downloadApk,
    cachedKeys: cachedKeys,
    invalidateCache: invalidateCache
  };

});

GooglePlay.test = function test() {
  var use_cache = ((process.env.USE_CACHE || true) !== "0") ? true : false;
  var debug = ((process.env.DEBUG || false) === "1") ? true : false;
  if (debug) {
    console.log('DEBUG: true');
    console.log("USE_CACHE: %s", use_cache);
  }
  var api = GooglePlay(
    process.env.GOOGLE_LOGIN, process.env.GOOGLE_PASSWORD,
    process.env.ANDROID_ID,
    use_cache,
    debug
  );
  return api.login()
  .then(function() {
    var pkg = 'com.viber.voip';
    api.details(pkg).then(function (res) {
      console.log('%j', res);
      return api.related(pkg);
    })
    .then(function (res) {
      console.log('%j', res);
      return api.getDownloadInfo(pkg, 37);
    })
    .then(function (res) {
      debugger;
    })
    .lastly(function () {
      process.exit(0);
    });
  });
};

module.exports = {
  GooglePlayAPI: GooglePlay,
  responseToObj: responseToObj
};