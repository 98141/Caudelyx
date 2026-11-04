export const scenarioKinds = ['PRUDENT', 'BASE', 'FAVORABLE'];
export const alternativeKinds = ['HOLD_CASH', 'DEBT_PREPAYMENT', 'NEW_LOAN', 'ASSET_PURCHASE'];
export const tables = ['s12_bases', 's12_scenarios', 's12_scenario_versions', 's12_runs', 's12_results', 's12_alerts', 's12_alert_evaluations', 's12_commands', 's12_limits', 's12_payload_chunks'];
export const limits = { days: 366, sourceRows: 10000, baseBytes: 16777216, expandedFlows: 50000, resultBytes: 16777216, workerMs: 10000, workerRSS: 268435456, requestsPerMinute: 10, queue: 8, payloadMs: 86400000, definitionMs: 2592000000, freshMs: 300000 };
//# sourceMappingURL=models.js.map