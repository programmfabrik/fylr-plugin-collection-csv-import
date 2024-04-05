const axios = require("axios");
global.CUI = require('./easydb-webfrontend/build/headless/cui'); // Set CUI variable globally.

// Simple override of XHR class.
CUI.XHR = class XHR extends CUI.Element {

    initOpts() {
        super.initOpts.call(this);
        this.addOpts({
            method: {
                mandatory: true,
                default: "GET",
                check: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
            },
            url: {
                mandatory: true,
                check: (v) => {
                    return v.trim().length > 0;
                }
            },
            body: {},
            timeout: {
                check: (v) => v >= 0,
                default: 0
            },
            headers: {
                check: "PlainObject",
                default: {}
            }
        });
        return this;
    }

    start() {
        const deferred = new CUI.Deferred();

        const config = {
            url: this._url,
            method: this._method.toLowerCase(),
            data: this._body,
            timeout: this._timeout,
            headers: this._headers
        };

        axios.request(config).then((response) => {
            return deferred.resolve(response.data)
        }).catch((error) => {
            if (error.response) {
                if (!error.response.data) {
                    error.response.data = {};
                }
                error.response.data.config = config;
                return deferred.reject(error.response);
            }
            return deferred.reject({data: "XHR Error", status: 500});
        });

        return deferred.promise();
    }
}
