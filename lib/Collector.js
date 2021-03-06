/** @fileoverview
 * Collector collects resource usages from all nodes in the cluster.
 * Member nodes only monitors local usage changes, and reports to Master.
 * Master nodes manages all resource usages from members. Allocation
 * only happens on master.
 */

var Class   = require('js-class'),
    elements = require('evo-elements'),
    Logger  = elements.Logger,
    Catalog = elements.Catalog,
    Message = require('evo-neuron').Message,
    idioms  = require('evo-idioms'),

    ResourceUsage = require('./ResourceUsage'),
    ResourcePool  = require('./ResourcePool'),
    UsageMonitor  = require('./UsageMonitor');

/** @class
 * @description The resource usage tracker
 */
var Collector = Class({
    constructor: function (connector, logger, opts) {
        this.connector = connector;
        this.logger = Logger.clone(logger, { prefix: '<collector> ' });

        // track dendrites which report usages
        this._extUsageNames = new Catalog();

        // resource usages of the whole cluster
        this._resourcePool = new ResourcePool(opts);

        // local resource usages only
        (this._localUsages = new UsageMonitor(opts))
            .on('changed', this.onLocalUsagesChanged.bind(this));

        this._states = new idioms.ConnectorStates(this.connector, {
            master: {
                update: this._clusterUpdated,
                'msg:collect.usages': this._clusterUsages
            },
            member: {
                enter: this._memberStateEntered,
                update: this._clusterUpdated,
                'fn:localUsages': this._reportUsages
            },
            default: {
                update: this._clusterUpdated,
                'msg:collect.usages': this._clusterUsages
            },
            context: this
        }).start();

        this.connector.neuron.on('disconnect', this.onDendriteDisconnect.bind(this));
    },

    get resourcePool () {
        return this._resourcePool;
    },

    /** @function
     * @description Usages reported from dendrites
     */
    importUsages: function (usages, src) {
        usages = ResourceUsage.importUsages(usages);
        if (usages) {
            if (src) {
                var names = this._extUsageNames.all(src, true);
                usages.forEach(function (usage) {
                    names[usage.name] = true;
                });
            }
            this._localUsages.updateUsages(usages);
        }
        return usages;
    },

    /** @function
     * @description Export local usages
     */
    exportUsages: function () {
        return this._localUsages.exportUsages();
    },

    // Triggered when local usages monitor detects a significant change
    onLocalUsagesChanged: function () {
        this._states.process('localUsages', this._localUsages);
    },

    // When a dendrite disconnects, all usages reported by it should be removed
    onDendriteDisconnect: function (id) {
        var names = this._extUsageNames.all(id);
        if (names) {
            this._extUsageNames.removeAll(id);
            this._localUsages.updateUsages([], Object.keys(names));
        }
    },

    _clusterUpdated: function (clusterInfo) {
        Array.isArray(clusterInfo.nodes) &&
            this._resourcePool.syncSources(
                clusterInfo.nodes.map(function (node) { return node.id; })
            );
    },

    _clusterUsages: function (msg, src) {
        var usages = msg.data && ResourceUsage.importUsages(msg.data.usages);
        usages && this._resourcePool.updateUsages(src, usages);
    },

    _memberStateEntered: function () {
        this._resourcePool.clear();
    },

    _reportUsages: function () {
        this.connector.send(Message.make('collect.usages', { usages: this.exportUsages() }), 'master');
    }
});

module.exports = Collector;
