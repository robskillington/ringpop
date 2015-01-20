// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var metrics = require('metrics');
var TypedError = require('error/typed');

var AdminJoiner = require('./lib/swim').AdminJoiner;
var createRingPopTChannel = require('./lib/tchannel.js').createRingPopTChannel;
var Dissemination = require('./lib/members').Dissemination;
var Gossip = require('./lib/swim.js').Gossip;
var HashRing = require('./lib/ring');
var Membership = require('./lib/members').Membership;
var MemberIterator = require('./lib/members').MemberIterator;
var nulls = require('./lib/nulls');
var PingReqSender = require('./lib/swim').PingReqSender;
var PingSender = require('./lib/swim').PingSender;
var safeParse = require('./lib/util').safeParse;
var RequestProxy = require('./lib/request-proxy');
var Suspicion = require('./lib/swim.js').Suspicion;

var IP_PATTERN = /^(\d+.\d+.\d+.\d+):\d+$/;
var MAX_JOIN_DURATION = 300000;

var InvalidJoinAppError = TypedError({
    type: 'ringpop.invalid-join.app',
    message: 'A node tried joining a different app cluster. The expected app' +
        ' ({expected}) did not match the actual app ({actual}).',
    expected: null,
    actual: null
});

var InvalidJoinSourceError = TypedError({
    type: 'ringpop.invalid-join.source',
    message:  'A node tried joining a cluster by attempting to join itself.' +
        ' The joiner ({actual}) must join someone else.',
    actual: null
});

var InvalidLeaveLocalMemberError = TypedError({
    type: 'ringpop.invalid-leave.local-member',
    message: 'An admin leave was attempted before the local member was added to the membership'
});

var RedundantLeaveError = TypedError({
    type: 'ringpop.invalid-leave.redundant',
    message: 'A node cannot leave its cluster when it has already left.'
});

function RingPop(options) {
    if (!(this instanceof RingPop)) {
        return new RingPop(options);
    }

    this.app = options.app;
    this.hostPort = options.hostPort;
    this.channel = options.channel;
    this.setLogger(options.logger || nulls.logger);
    this.statsd = options.statsd || nulls.statsd;
    this.bootstrapFile = options.bootstrapFile;

    this.isReady = false;
    this.isRunning = false;

    this.debugFlags = {};
    this.joinSize = 3;              // join fanout
    this.pingReqSize = 3;           // ping-req fanout
    this.pingReqTimeout = 5000;
    this.pingTimeout = 1500;
    this.proxyReqTimeout = options.proxyReqTimeout || 30000;
    this.minProtocolPeriod = 200;
    this.lastProtocolPeriod = Date.now();
    this.lastProtocolRate = 0;
    this.protocolPeriods = 0;
    this.maxJoinDuration = options.maxJoinDuration || MAX_JOIN_DURATION;

    this.requestProxy = new RequestProxy(this);
    this.ring = new HashRing();
    this.dissemination = new Dissemination(this);
    this.membership = new Membership(this);
    this.membership.on('updated', this.onMembershipUpdated.bind(this));
    this.memberIterator = new MemberIterator(this);
    this.gossip = new Gossip(this);
    this.suspicion = new Suspicion(this);

    this.timing = new metrics.Histogram();
    this.timing.update(this.minProtocolPeriod);
    this.clientRate = new metrics.Meter();
    this.serverRate = new metrics.Meter();
    this.totalRate = new metrics.Meter();

    this.protocolRateTimer = null;

    this.statHostPort = this.hostPort.replace(':', '_');
    this.statPrefix = 'ringpop.' + this.statHostPort;
    this.statKeys = {};
    this.destroyed = false;
    this.joiner = null;
}

require('util').inherits(RingPop, EventEmitter);

RingPop.prototype.destroy = function destroy() {
    this.destroyed = true;
    this.gossip.stop();
    this.suspicion.stopAll();
    clearInterval(this.protocolRateTimer);

    this.clientRate.m1Rate.stop();
    this.clientRate.m5Rate.stop();
    this.clientRate.m15Rate.stop();
    this.serverRate.m1Rate.stop();
    this.serverRate.m5Rate.stop();
    this.serverRate.m15Rate.stop();
    this.totalRate.m1Rate.stop();
    this.totalRate.m5Rate.stop();
    this.totalRate.m15Rate.stop();

    if (this.joiner) {
        this.joiner.destroy();
    }

    if (this.channel) {
        this.channel.quit();
    }
};

RingPop.prototype.setupChannel = function setupChannel() {
    createRingPopTChannel(this, this.channel);
};

RingPop.prototype.addLocalMember = function addLocalMember() {
    this.membership.addMember({ address: this.hostPort });
};

RingPop.prototype.adminJoin = function adminJoin(target, callback) {
    if (this.membership.localMember.status === 'leave') {
        return this.rejoin(function() {
            callback(null, null, 'rejoined');
        });
    }

    if (this.joiner) {
        this.joiner.destroy();
        this.joiner = null;
    }

    this.joiner = new AdminJoiner({
        ringpop: this,
        target: target,
        callback: callback,
        maxJoinDuration: this.maxJoinDuration
    });
    this.joiner.sendJoin();
};

RingPop.prototype.adminLeave = function adminLeave(callback) {
    if (!this.membership.localMember) {
        return callback(InvalidLeaveLocalMemberError());
    }

    if (this.membership.localMember.status === 'leave') {
        return callback(RedundantLeaveError());
    }

    // TODO Explicitly infect other members (like admin join)?
    this.membership.makeLeave();
    this.gossip.stop();
    this.suspicion.stopAll();

    callback(null, null, 'ok');
};

RingPop.prototype.bootstrap = function bootstrap(bootstrapFile, callback) {
    if (typeof bootstrapFile === 'function') {
        callback = bootstrapFile;
        bootstrapFile = null;
    }

    var self = this;

    if (this.isReady) {
        var alreadyReadyMsg = 'ringpop is already ready';
        this.logger.warn(alreadyReadyMsg, { address: this.hostPort });
        if (callback) callback(new Error(alreadyReadyMsg));
        return;
    }

    var start = new Date();

    this.seedBootstrapHosts(bootstrapFile);

    if (!Array.isArray(this.bootstrapHosts) || this.bootstrapHosts.length === 0) {
        var noBootstrapMsg = 'ringpop cannot be bootstrapped without bootstrap hosts.' +
            ' make sure you specify a valid bootstrap hosts file to the ringpop' +
            ' constructor or have a valid hosts.json file in the current working' +
            ' directory.';
        this.logger.warn(noBootstrapMsg);
        if (callback) callback(new Error(noBootstrapMsg));
        return;
    }

    this.checkForMissingBootstrapHost();
    this.checkForHostnameIpMismatch();

    this.addLocalMember();

    this.adminJoin(function(err) {
        if (err) {
            var failedMsg = 'ringpop bootstrap failed';
            self.logger.error(failedMsg, {
                err: err.message,
                address: self.hostPort
            });
            if (callback) callback(new Error(failedMsg));
            return;
        }

        if (self.destroyed) {
            var destroyedMsg = 'ringpop was destroyed ' +
                'during bootstrap';
            self.logger.error(destroyedMsg, {
                address: self.hostPort
            });
            if (callback) callback(new Error(destroyedMsg));
            return;
        }

        self.logger.info('ringpop is ready', {
            address: self.hostPort,
            bootstrapTime: new Date() - start,
            memberCount: self.membership.getMemberCount()
        });

        self.startProtocolPeriod();
        self.startProtocolRateTimer();

        self.isReady = true;
        self.emit('ready');

        if (callback) callback();
    });
};

RingPop.prototype.checkForMissingBootstrapHost = function checkForMissingBootstrapHost() {
    if (this.bootstrapHosts.indexOf(this.hostPort) === -1) {
        this.logger.warn('bootstrap hosts does not include the host/port of' +
            ' the local node. this may be fine because your hosts file may' +
            ' just be slightly out of date, but it may also be an indication' +
            ' that your node is identifying itself incorrectly.', {
            address: this.hostPort
        });

        return false;
    }

    return true;
};

RingPop.prototype.checkForHostnameIpMismatch = function checkForHostnameIpMismatch() {
    var self = this;

    function testMismatch(msg, filter) {
        var filteredHosts = self.bootstrapHosts.filter(filter);

        if (filteredHosts.length > 0) {
            self.logger.warn(msg, {
                address: self.hostPort,
                mismatchedBootstrapHosts: filteredHosts
            });

            return false;
        }

        return true;
    }

    if (IP_PATTERN.test(this.hostPort)) {
        var ipMsg = 'your ringpop host identifier looks like an IP address and there are' +
            ' bootstrap hosts that appear to be specified with hostnames. these inconsistencies' +
            ' may lead to subtle node communication issues';

        return testMismatch(ipMsg, function(host) {
            return !IP_PATTERN.test(host);
        });
    } else {
        var hostMsg = 'your ringpop host identifier looks like a hostname and there are' +
            ' bootstrap hosts that appear to be specified with IP addresses. these inconsistencies' +
            ' may lead to subtle node communication issues';

        return testMismatch(hostMsg, function(host) {
            return IP_PATTERN.test(host);
        });
    }

    return true;
};

RingPop.prototype.clearDebugFlags = function clearDebugFlags() {
    this.debugFlags = {};
};

RingPop.prototype.protocolRate = function () {
    var observed = this.timing.percentiles([0.5])['0.5'] * 2;
    return Math.max(observed, this.minProtocolPeriod);
};

RingPop.prototype.getStats = function getStats() {
    return {
        membership: this.membership.getStats(),
        process: {
            memory: process.memoryUsage(),
            pid: process.pid
        },
        protocol: {
            timing: this.timing.printObj(),
            protocolRate: this.protocolRate(),
            clientRate: this.clientRate.printObj().m1,
            serverRate: this.serverRate.printObj().m1,
            totalRate: this.totalRate.printObj().m1
        },
        ring: Object.keys(this.ring.servers)
    };
};

RingPop.prototype.handleTick = function handleTick(cb) {
    var self = this;
    this.pingMemberNow(function () {
        cb(null, JSON.stringify({ checksum: self.membership.checksum }));
    });
};

RingPop.prototype.protocolJoin = function protocolJoin(options, callback) {
    this.stat('increment', 'join.recv');

    var joinerAddress = options.source;
    if (joinerAddress === this.whoami()) {
        return callback(InvalidJoinSourceError({ actual: joinerAddress }));
    }

    var joinerApp = options.app;
    if (joinerApp !== this.app) {
        return callback(InvalidJoinAppError({ expected: this.app, actual: joinerApp }));
    }

    this.serverRate.mark();
    this.totalRate.mark();

    this.membership.addMember({
        address: joinerAddress,
        incarnationNumber: options.incarnationNumber
    });

    callback(null, {
        app: this.app,
        coordinator: this.whoami(),
        membership: this.membership.getState()
    });
};

RingPop.prototype.protocolLeave = function protocolLeave(node, callback) {
    callback();
};

RingPop.prototype.protocolPing = function protocolPing(options, callback) {
    this.stat('increment', 'ping.recv');

    var source = options.source;
    var changes = options.changes;
    var checksum = options.checksum;

    this.serverRate.mark();
    this.totalRate.mark();

    this.membership.update(changes);

    callback(null, {
        changes: this.issueMembershipChanges(checksum, source)
    });
};

RingPop.prototype.protocolPingReq = function protocolPingReq(options, callback) {
    this.stat('increment', 'ping-req.recv');

    var source = options.source;
    var target = options.target;
    var changes = options.changes;
    var checksum = options.checksum;

    this.serverRate.mark();
    this.totalRate.mark();
    this.membership.update(changes);

    var self = this;
    this.logger.debug('ping-req send ping source=' + source + ' target=' + target, 'p');
    var start = new Date();
    this.sendPing(target, function (isOk, body) {
        self.stat('timing', 'ping-req-ping', start);
        self.logger.debug('ping-req recv ping source=' + source + ' target=' + target + ' isOk=' + isOk, 'p');
        if (isOk) {
            self.membership.update(body.changes);
        }
        callback(null, {
            changes: self.issueMembershipChanges(checksum, source),
            pingStatus: isOk,
            target: target
        });
    });
};

RingPop.prototype.lookup = function lookup(key) {
    this.stat('increment', 'lookup');
    var dest = this.ring.lookup(key + '');

    if (!dest) {
        this.logger.debug('could not find destination for ' + key);
        return this.whoami();
    }

    return dest;
};

RingPop.prototype.reload = function reload(file, callback) {
    this.seedBootstrapHosts(file);

    callback();
};

RingPop.prototype.whoami = function whoami() {
    return this.hostPort;
};

RingPop.prototype.computeProtocolDelay = function computeProtocolDelay() {
    if (this.protocolPeriods) {
        var target = this.lastProtocolPeriod + this.lastProtocolRate;
        return Math.max(target - Date.now(), this.minProtocolPeriod);
    } else {
        // Delay for first tick will be staggered from 0 to `minProtocolPeriod` ms.
        return Math.floor(Math.random() * (this.minProtocolPeriod + 1));
    }
};

RingPop.prototype.issueMembershipChanges = function issueMembershipChanges(checksum, source) {
    return this.dissemination.getChanges(checksum, source);
};

RingPop.prototype.onMembershipUpdated = function onMembershipUpdated(updates) {
    var self = this;

    var updateHandlers = {
        alive: function onAliveMember(member) {
            /* jshint camelcase: false */
            self.stat('increment', 'membership-update.alive');
            self.logger.info('member is alive', {
                local: self.membership.localMember.address,
                alive: member.address
            });
            self.suspicion.stop(member);
            self.ring.addServer(member.address);
            self.dissemination.addChange({
                address: member.address,
                status: member.status,
                incarnationNumber: member.incarnationNumber,
                piggybackCount: 0
            });
        },
        faulty: function onFaultyMember(member) {
            /* jshint camelcase: false */
            self.stat('increment', 'membership-update.faulty');
            self.logger.warn('member is faulty', {
                local: self.membership.localMember.address,
                faulty: member.address
            });
            self.suspicion.stop(member);
            self.ring.removeServer(member.address);
            self.dissemination.addChange({
                address: member.address,
                status: member.status,
                incarnationNumber: member.incarnationNumber,
                piggybackCount: 0
            });
        },
        leave: function onLeaveMember(member) {
            /* jshint camelcase: false */
            self.stat('increment', 'membership-update.leave');
            self.logger.warn('member has left', {
                local: self.membership.localMember.address,
                leave: member.address
            });
            self.suspicion.stop(member);
            self.ring.removeServer(member.address);
            self.dissemination.addChange({
                address: member.address,
                status: member.status,
                incarnationNumber: member.incarnationNumber,
                piggybackCount: 0
            });
        },
        new: function onNewMember(member) {
            /* jshint camelcase: false */
            self.stat('increment', 'membership-update.new');
            self.ring.addServer(member.address);
            self.dissemination.addChange({
                address: member.address,
                status: member.status,
                incarnationNumber: member.incarnationNumber,
                piggybackCount: 0
            });
        },
        suspect: function onSuspectMember(member) {
            self.stat('increment', 'membership-update.suspect');
            self.logger.warn('member is suspect', {
                local: self.membership.localMember.address,
                suspect: member.address
            });
            self.suspicion.start(member);
            self.dissemination.addChange({
                address: member.address,
                status: member.status,
                incarnationNumber: member.incarnationNumber,
                piggybackCount: 0
            });
        }
    };

    updates.forEach(function(update) {
        var handler = updateHandlers[update.type];

        if (handler) {
            handler(update);
        }
    });

    if (updates.length > 0) {
        this.emit('changed');
    }

    this.stat('gauge', 'num-members', this.membership.members.length);
    this.stat('timing', 'updates', updates.length);
};

RingPop.prototype.pingMemberNow = function pingMemberNow(callback) {
    callback = callback || function() {};

    if (this.isPinging) {
        this.logger.warn('aborting ping because one is in progress');
        return callback();
    }

    if (!this.isReady) {
        this.logger.warn('ping started before ring initialized');
        return callback();
    }

    this.lastProtocolPeriod = Date.now();
    this.protocolPeriods++;

    var member = this.memberIterator.next();

    if (! member) {
        this.logger.warn('no usable nodes at protocol period');
        return callback();
    }

    var self = this;
    this.isPinging = true;
    var start = new Date();
    this.sendPing(member, function(isOk, body) {
        self.stat('timing', 'ping', start);
        if (isOk) {
            self.isPinging = false;
            self.membership.update(body.changes);
            return callback();
        }

        if (self.destroyed) {
            return callback(new Error('destroyed whilst pinging'));
        }

        start = new Date();
        self.sendPingReq(member, function() {
            self.stat('timing', 'ping-req', start);
            self.isPinging = false;

            callback.apply(null, Array.prototype.splice.call(arguments, 0));
        });
    });
};

RingPop.prototype.readHostsFile = function readHostsFile(file) {
    if (!file) {
        return false;
    }

    if (!fs.existsSync(file)) {
        this.logger.warn('bootstrap hosts file does not exist', { file: file });
        return false;
    }

    try {
        return safeParse(fs.readFileSync(file).toString());
    } catch (e) {
        this.logger.warn('failed to read bootstrap hosts file', {
            err: e.message,
            file: file
        });
    }
};

RingPop.prototype.rejoin = function rejoin(callback) {
    this.membership.makeAlive();

    this.gossip.restart();
    this.suspicion.reenable();

    // TODO Rejoin may eventually necessitate fan-out thus
    // the need for the asynchronous-style callback.
    callback();
};

RingPop.prototype.seedBootstrapHosts = function seedBootstrapHosts(file) {
    if (Array.isArray(file)) {
        this.bootstrapHosts = file;
    } else {
        this.bootstrapHosts = this.readHostsFile(file) ||
            this.readHostsFile(this.bootstrapFile) ||
            this.readHostsFile('./hosts.json');
    }
};

RingPop.prototype.sendPing = function sendPing(member, callback) {
    this.stat('increment', 'ping.send');
    return new PingSender(this, member, callback);
};

// TODO Exclude suspect memebers from ping-req as well?
RingPop.prototype.sendPingReq = function sendPingReq(unreachableMember, callback) {
    this.stat('increment', 'ping-req.send');

    var otherMembers = this.membership.getRandomPingableMembers(this.pingReqSize, [unreachableMember.address]);
    var self = this;
    var completed = 0;
    var anySuccess = false;
    function onComplete(err) {
        anySuccess |= !err;

        if (++completed === otherMembers.length) {
            self.membership.update([{
                address: unreachableMember.address,
                incarnationNumber: unreachableMember.incarnationNumber,
                status: anySuccess ? 'alive' : 'suspect'
            }]);

            callback();
        }
    }

    this.stat('timing', 'ping-req.other-members', otherMembers.length);

    if (otherMembers.length > 0) {
        otherMembers.forEach(function (member) {
            self.logger.debug('ping-req send peer=' + member.address +
                ' target=' + unreachableMember.address, 'p');
            return new PingReqSender(self, member, unreachableMember, onComplete);
        });
    } else {
        callback(new Error('No members to ping-req'));
    }
};

RingPop.prototype.setDebugFlag = function setDebugFlag(flag) {
    this.debugFlags[flag] = true;
};

RingPop.prototype.setLogger = function setLogger(logger) {
    var self = this;
    this.logger = {
        debug: function(msg, flag) {
            if (self.debugFlags && self.debugFlags[flag]) {
                logger.info(msg);
            }
        },
        error: logger.error.bind(logger),
        info: logger.info.bind(logger),
        warn: logger.warn.bind(logger)
    };
};

RingPop.prototype.startProtocolPeriod = function startProtocolPeriod() {
    if (this.isRunning) {
        this.logger.warn('ringpop is already gossiping and will not' +
            ' start another protocol period.', { address: this.hostPort });
        return;
    }

    this.isRunning = true;
    this.membership.shuffle();
    this.gossip.start();
    this.logger.info('ringpop has started gossiping', { address: this.hostPort });
};

RingPop.prototype.startProtocolRateTimer = function startProtocolRateTimer() {
    this.protocolRateTimer = setInterval(function () {
        this.lastProtocolRate = this.protocolRate();
    }.bind(this), 1000);
};

RingPop.prototype.stat = function stat(type, key, value) {
    if (!this.statKeys[key]) {
        this.statKeys[key] = this.statPrefix + '.' + key;
    }

    var fqKey = this.statKeys[key];

    if (type === 'increment') {
        this.statsd.increment(fqKey, value);
    } else if (type === 'gauge') {
        this.statsd.gauge(fqKey, value);
    } else if (type === 'timing') {
        this.statsd.timing(fqKey, value);
    }
};

RingPop.prototype.handleIncomingRequest =
    function handleIncomingRequest(header, body, cb) {
        this.requestProxy.handleRequest(header, body, cb);
    };

RingPop.prototype.proxyReq =
    function proxyReq(destination, req, res, opts) {
        this.requestProxy.proxyReq(destination, req, res, opts);
    };

RingPop.prototype.handleOrProxy =
    function handleOrProxy(key, req, res, opts) {
        var dest = this.lookup(key);

        if (this.whoami() === dest) {
            return true;
        } else {
            this.proxyReq(dest, req, res, opts);
        }
    };

module.exports = RingPop;
