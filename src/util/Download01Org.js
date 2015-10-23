// Copyright © 2014 Intel Corporation. All rights reserved.
// Use  of this  source  code is  governed by  an Apache v2
// license that can be found in the LICENSE-APACHE-V2 file.

var FS = require("fs");
var Path = require("path");

var MemoryStream = require("memorystream");
var ShellJS = require("shelljs");

var IndexParser = require("./IndexParser");

var BASE_URL = "https://download.01.org/crosswalk/releases/crosswalk/android/";

// Channels are in preferred search order.
var CHANNELS = ["stable", "beta", "canary"];



/**
 * Callback signature for {@link Download01Org.fetchVersions}
 * @param {String[]} versions Array of available Crosswalk versions sorted oldest - newest
 * @param {String} errormsg Message in case of Error
 * @inner
 * @memberOf Download01Org
 */
function fetchVersionsFinishedCb(versions, errormsg) {}

/**
 * Callback signature for {@link Download01Org.download}.
 * @param {String} path Path to downloaded file, or null on error
 * @param {String} errormsg null if success, otherwise error message
 * @inner
 * @memberOf Download01Org
 */
function downloadFinishedCb(path, errormsg) {}



/**
 * Crosswalk release lookup and download.
 * @constructor
 * @param {Application} application application instance
 * @param {String} channel Crosswalk channel beta/canary/stable
 * @throws {Download01Org~InvalidChannelError} If no valid channel was specified.
 */
function Download01Org(application, channel) {

    this._application = application;

    if (CHANNELS.indexOf(channel) == -1) {
        throw new InvalidChannelError("Unknown channel " + channel);
    }

    this._channel = channel;
}

/**
 * Read-only array of valid release channels (stable, beta, canary).
 * @member {String[]} CHANNELS
 * @static
 * @memberOf Download01Org
 */
Object.defineProperty(Download01Org, "CHANNELS", {
                      get: function() {
                                return CHANNELS;
                           },
                      set: function(config) {
                                // Empty because read-only
                           }
                      });

/**
 * Fetch available Crosswalk versions index.
 * @param {Download01Org~fetchVersionsFinishedCb} callback callback function
 */
Download01Org.prototype.fetchVersions =
function(callback) {

    // Namespace util
    var util = this._application.util;
    var output = this._application.output;
    var url = BASE_URL + this._channel + "/";

    // Download
    var stream = new MemoryStream();
    var buffer = "";
    stream.on("data", function(data) {
        buffer += data.toString();
    });

    // Namespace util
    var downloader = new util.Downloader(url, stream);

    var label = "Fetching '" + this._channel + "' versions index";
    var indicator = output.createFiniteProgress(label);
    downloader.progress = function(progress) {
        indicator.update(progress);
    };

    downloader.get(function(errormsg) {

        indicator.done("");

        if (errormsg) {

            callback(null, errormsg);

        } else {

            // Parse
            var parser = new IndexParser(buffer);
            var versions = parser.parse();
            callback(versions);
        }
    });
};

/**
 * Locate Crosswalk distribution zip.
 * @param {String} version Crosswalk version to look for
 * @returns {String} Relative path to zip file.
 */
Download01Org.prototype.findLocally =
function(version) {

    var filename = "crosswalk-" + version + ".zip";
    if (ShellJS.test("-f", filename))  {
        return filename;
    } else if (ShellJS.test("-f", "../" + filename)) {
        // Also try parent dir.
        // This is especially useful for tests that run in a temporary dir.
        return "../" + filename;
    }

    return null;
};

/**
 * Download crosswalk zip, checks for already existing file, and returns it in case.
 * @param {String} version Crosswalk version string
 * @param {String} defaultPath Directory to download to if not already exists
 * @param {Download01Org~downloadFinishedCb} callback callback function
 * @throws {FileCreationFailed} If download file could not be written.
 */
Download01Org.prototype.download =
function(version, defaultPath, callback) {

    // Namespaces
    var exceptions = this._application.exceptions;
    var util = this._application.util;

    var output = this._application.output;
    var filename = "crosswalk-" + version + ".zip";
    var url = BASE_URL +
              this._channel + "/" +
              version + "/" +
              filename;

    // Check for existing download in defaultPath, parent dir, and cache dir if set
    var handler = new util.DownloadHandler(defaultPath, filename);
    var localDirs = [defaultPath, ""];
    if (process.env.CROSSWALK_APP_TOOLS_CACHE_DIR)
        localDirs.push(process.env.CROSSWALK_APP_TOOLS_CACHE_DIR);
    var localPath = handler.findLocally(localDirs);
    if (localPath) {
        output.info("Using cached " + localPath);
        callback(localPath);
        return;
    }

    // Download
    var label = "Downloading '" + this._channel + "' " + version;
    var indicator = output.createFiniteProgress(label);

    var stream = handler.createStream();
    var downloader = new util.Downloader(url, stream);
    downloader.progress = function(progress) {
        indicator.update(progress);
    };
    downloader.get(function(errormsg) {

        indicator.done("");

        if (errormsg) {

            callback(null, errormsg);

        } else {

            var finishedPath = handler.finish(process.env.CROSSWALK_APP_TOOLS_CACHE_DIR);
            callback(finishedPath);
        }
    });
};

/**
 * Find a specific version in a specific channel.
 * @param {String} version Version to look for, pick lastest if null is given
 * @param {String} channel Release channel to seach in, null for all channels
 * @param {Function} callback Callback (version, channel, errormsg)
 */
Download01Org.prototype.findCrosswalkVersion =
function(version, channel, callback) {

    var output = this._application.output;

    var versionName = version ?
                        version :
                        "latest version";

    // Start with first channel if not given.
    if (!channel) {
        channel = Download01Org.CHANNELS[0];
    }

    output.info("Looking for " + versionName + " in channel '" + channel + "'");

    var deps = new Download01Org(this._application, channel);
    deps.fetchVersions(function(versions, errormsg) {

        if (errormsg) {
            callback(null, null, errormsg);
            return;
        }

        // Look for specific version?
        if (version &&
            versions.indexOf(version) > -1) {

            callback(version, channel, null);
            return;

        } else if (version) {

            // Try next channel.
            var channelIndex = Download01Org.CHANNELS.indexOf(channel);
            if (channelIndex < Download01Org.CHANNELS.length - 1) {
                output.info("Version " + version + " not found in '" + channel + "', trying next channel");
                channelIndex++;
                channel = Download01Org.CHANNELS[channelIndex];
                this.findCrosswalkVersion(version, channel, callback);
            } else {
                // Already at last channel, version not found
                output.info("Version " + version + " not found in '" + channel + "', search failed");
                callback(null, null, "Version " + version + " seems not to be available on the server");
                return;
            }
        } else {
            // Use latest from current channel.
            version = IndexParser.pickLatest(versions, function (errmsg) {
                errormsg = errmsg;
            });
            callback(version, channel, errormsg);
            return;
        }
    }.bind(this));
};

/**
 * Look up and download correct crosswalk release.
 * @param {String} versionSpec Crosswalk version or channel (stable, beta, canary)
 * @param {Function} importCrosswalkFromDisk(path) function to extract downloaded release
 * @param {Function} callback Callback(version, errormsg)
 */
Download01Org.prototype.importCrosswalk =
function(versionSpec, importCrosswalkFromDisk, callback) {

    var output = this._application.output;

    var channel = null;
    var version = null;

    if (ShellJS.test("-e", versionSpec)) {

        // versionSpec is a filename, import directly
        var filename = Path.normalize(Path.resolve(versionSpec));
        output.info("Using " + versionSpec);
        errormsg = null;
        var importedVersion = importCrosswalkFromDisk(filename);
        if (!importedVersion) {
            errormsg = "Failed to import from " + filename;
        }
        callback(importedVersion, errormsg);
        return;

    } else if (Download01Org.CHANNELS.indexOf(versionSpec) > -1) {
        // versionSpec is a channel name
        channel = versionSpec;
    } else {
        version = versionSpec;
    }

    // Download
    var deps = new Download01Org(this._application, channel);
    deps.findCrosswalkVersion(version, channel,
                              function(version, channel, errormsg) {

        if (errormsg) {
            callback(null, errormsg);
            return;
        }

        output.info("Found version '" + version + "' in channel '" + channel + "'");

        // Download latest Crosswalk
        var deps = new Download01Org(this._application, channel);
        deps.download(version, ".",
                      function(filename, errormsg) {

            if (errormsg) {
                callback(null, errormsg);
                return;
            }

            if (!filename) {
                callback(null, "Failed to download Crosswalk");
                return;
            }

            errormsg = null;
            var importedVersion = importCrosswalkFromDisk(filename);
            if (!importedVersion) {
                errormsg = "Failed to extract " + filename;
            }
            callback(importedVersion, errormsg);

        }.bind(this));
    }.bind(this));
};



/**
 * Creates a new InvalidChannelError.
 * @extends Error
 * @constructor
 * @param {String} message Error message
 * @inner
 * @memberOf Download01Org
 */
function InvalidChannelError(message) {
    Error.call(this, message);
}
InvalidChannelError.prototype = Object.create(Error.prototype);
InvalidChannelError.prototype.constructor = InvalidChannelError;

Download01Org.prototype.InvalidChannelError = InvalidChannelError;



module.exports = Download01Org;
