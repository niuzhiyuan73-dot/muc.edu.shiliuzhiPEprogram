const { MATCH_TYPE } = require('./constants.js');

// 重抽要预留逐场读写、身份与审计的事务预算；页面与服务端使用同一个上限。
const DRAW_MATCH_MAX = 44;
const drawCapacityOf = event => DRAW_MATCH_MAX * 2 * (event && event.matchType === MATCH_TYPE.DOUBLES ? 2 : 1);
module.exports = { DRAW_MATCH_MAX, drawCapacityOf };
