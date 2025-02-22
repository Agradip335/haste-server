const http = require("http");
const fs = require("fs");
const path = require("path");

const winston = require("winston");
const connect = require("connect");
const route = require("connect-route");
const connect_st = require("st");
const connect_rate_limit = require("connect-ratelimit");

const babel = require("@babel/core");
const CleanCSS = require("clean-css");

const DocumentHandler = require("./lib/document_handler");

// Load the configuration and set some defaults
const configPath = process.argv.length <= 2 ? "config.js" : process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.port = process.env.PORT || config.port || 7777;
config.host = process.env.HOST || config.host || "localhost";

// Set up the logger
if (config.logging) {
    try {
        winston.remove(winston.transports.Console);
    } catch (e) {
        /* was not present */
    }

    var detail, type;
    for (var i = 0; i < config.logging.length; i++) {
        detail = config.logging[i];
        type = detail.type;
        delete detail.type;
        winston.add(winston.transports[type], detail);
    }
}

// build the store from the config on-demand - so that we don't load it
// for statics
if (!config.storage) {
    config.storage = { type: "file" };
}
if (!config.storage.type) {
    config.storage.type = "file";
}

var Store, preferredStore;

if (process.env.REDISTOGO_URL && config.storage.type === "redis") {
    var redisClient = require("redis-url").connect(process.env.REDISTOGO_URL);
    Store = require("./lib/document_stores/redis");
    preferredStore = new Store(config.storage, redisClient);
} else {
    Store = require("./lib/document_stores/" + config.storage.type);
    preferredStore = new Store(config.storage);
}

// Compress the static javascript and css assets
if (config.recompressStaticAssets) {
    const list = fs.readdirSync("./static");

    for (const item of list) {
        const filePath = path.join("./static", item);

        // Minify JavaScript files
        if (item.endsWith(".js") && !item.endsWith(".min.js")) {
            const dest = item.replace(/\.js$/, ".min.js");
            const orig_code = fs.readFileSync(filePath, "utf8");

            const minified_code = babel.transformSync(orig_code, {
                presets: [["minify", { builtIns: false, evaluate: false }]],
                comments: false,
            }).code;

            fs.writeFileSync(
                path.join("./static", dest),
                minified_code,
                "utf8"
            );
            winston.info(`compressed ${item} into ${dest}`);
        }

        // Minify CSS files
        if (item.endsWith(".css") && !item.endsWith(".min.css")) {
            const dest = item.replace(/\.css$/, ".min.css");
            const orig_code = fs.readFileSync(filePath, "utf8");

            const minified_code = new CleanCSS().minify(orig_code).styles;

            fs.writeFileSync(
                path.join("./static", dest),
                minified_code,
                "utf8"
            );
            winston.info(`compressed ${item} into ${dest}`);
        }
    }
}

// Send the static documents into the preferred store, skipping expirations
var staticDocPath, data;
for (var name in config.documents) {
    staticDocPath = config.documents[name];
    data = fs.readFileSync(staticDocPath, "utf8");
    winston.info("loading static document", {
        name: name,
        path: staticDocPath,
    });
    if (data) {
        preferredStore.set(
            name,
            data,
            function (cb) {
                winston.debug("loaded static document", { success: cb });
            },
            true
        );
    } else {
        winston.warn("failed to load static document", {
            name: name,
            path: staticDocPath,
        });
    }
}

// Pick up a key generator
var pwOptions = config.keyGenerator || {};
pwOptions.type = pwOptions.type || "random";
var gen = require("./lib/key_generators/" + pwOptions.type);
var keyGenerator = new gen(pwOptions);

// Configure the document handler
var documentHandler = new DocumentHandler({
    store: preferredStore,
    maxLength: config.maxLength,
    keyLength: config.keyLength,
    keyGenerator: keyGenerator,
});

var app = connect();

// Rate limit all requests
if (config.rateLimits) {
    config.rateLimits.end = true;
    app.use(connect_rate_limit(config.rateLimits));
}

// first look at API calls
app.use(
    route(function (router) {
        // get raw documents - support getting with extension

        router.get("/raw/:id", function (request, response) {
            return documentHandler.handleRawGet(request, response, config);
        });

        router.head("/raw/:id", function (request, response) {
            return documentHandler.handleRawGet(request, response, config);
        });

        // add documents

        router.post("/documents", function (request, response) {
            return documentHandler.handlePost(request, response);
        });

        // get documents
        router.get("/documents/:id", function (request, response) {
            return documentHandler.handleGet(request, response, config);
        });

        router.head("/documents/:id", function (request, response) {
            return documentHandler.handleGet(request, response, config);
        });
    })
);

// Otherwise, try to match static files
app.use(
    connect_st({
        path: __dirname + "/static",
        content: { maxAge: config.staticMaxAge },
        passthrough: true,
        index: false,
    })
);

// Then we can loop back - and everything else should be a token,
// so route it back to /
app.use(
    route(function (router) {
        router.get("/:id", function (request, response, next) {
            request.sturl = "/";
            next();
        });
    })
);

// And match index
app.use(
    connect_st({
        path: __dirname + "/static",
        content: { maxAge: config.staticMaxAge },
        index: "index.html",
    })
);

http.createServer(app).listen(config.port, config.host);

winston.info("listening on " + config.host + ":" + config.port);
