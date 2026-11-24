/**
 * 头像上传
 * ============================================================
 * 这一块的坑全在「什么算已经就绪的地址」上：微信给的临时路径必须换成
 * fileID，而已经换好的、或者本来就是网络地址的，绝不能再传一次（也没
 * 法传——它们不是本地文件）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../miniprogram/services/runtime-mode.js');
const { uploadAvatar, isTempPath, buildCloudPath } = require('../miniprogram/services/avatar.js');
const { DATA_SOURCE } = require('../src/shared/utils/constants.js');

/** 记录 uploadFile 的调用，并按需伪造成功 / 失败 */
let uploads = [];
let uploadResult = { fileID: 'cloud://test.env/avatars/a.jpeg' };
let uploadShouldThrow = false;

global.wx = {
  cloud: {
    uploadFile(options) {
      uploads.push(options);
      if (uploadShouldThrow) return Promise.reject(new Error('上传失败'));
      return Promise.resolve(uploadResult);
    },
  },
};

/** 假云开发环境里没有 storage，用一个固定返回兜住 globalData 也够用 */
global.getApp = () => ({ globalData: {} });

test.beforeEach(() => {
  uploads = [];
  uploadResult = { fileID: 'cloud://test.env/avatars/a.jpeg' };
  uploadShouldThrow = false;
  runtime.setDataSource(DATA_SOURCE.CLOUD);
});

test.after(() => {
  runtime.setDataSource(DATA_SOURCE.MOCK);
});

/* ---------- 地址判定 ---------- */

test('临时路径 —— 认得出真机与开发者工具给的两种形态', () => {
  assert.strictEqual(isTempPath('wxfile://tmp_abc.jpeg'), true);
  assert.strictEqual(isTempPath('http://tmp/TaSMk5.jpeg'), true);
  assert.strictEqual(isTempPath('http://usr/abc.png'), true);
});

test('临时路径 —— 换好的 fileID 与网络地址不再当成临时文件', () => {
  assert.strictEqual(isTempPath('cloud://test.env/avatars/a.jpeg'), false);
  assert.strictEqual(isTempPath('https://example.com/a.png'), false);
  assert.strictEqual(isTempPath(''), false);
});

test('云存储路径 —— 带上目录、时间戳与扩展名，且两次不同名', () => {
  const first = buildCloudPath('http://tmp/a.jpeg');
  const second = buildCloudPath('http://tmp/a.jpeg');

  assert.match(first, /^avatars\/\d+-[a-z0-9]+\.jpeg$/);
  assert.notStrictEqual(first, second, '同名会互相覆盖');
});

test('云存储路径 —— 没有扩展名时按 jpeg 兜底', () => {
  assert.match(buildCloudPath('wxfile://tmp_abc'), /\.jpeg$/);
});

/* ---------- 上传 ---------- */

test('上传 —— 临时路径会传上去，返回的是 fileID', async () => {
  const result = await uploadAvatar('http://tmp/TaSMk5.jpeg');

  assert.strictEqual(result, 'cloud://test.env/avatars/a.jpeg');
  assert.strictEqual(uploads.length, 1);
  assert.strictEqual(uploads[0].filePath, 'http://tmp/TaSMk5.jpeg');
  assert.match(uploads[0].cloudPath, /^avatars\//);
});

test('上传 —— 已经是 fileID 的原样返回，不会重复上传', async () => {
  const result = await uploadAvatar('cloud://test.env/avatars/a.jpeg');

  assert.strictEqual(result, 'cloud://test.env/avatars/a.jpeg');
  assert.strictEqual(uploads.length, 0);
});

test('上传 —— 空值直接返回空串，不碰 wx', async () => {
  assert.strictEqual(await uploadAvatar(''), '');
  assert.strictEqual(await uploadAvatar(null), '');
  assert.strictEqual(uploads.length, 0);
});

test('上传 —— 失败时退回空串，不抛错', async () => {
  uploadShouldThrow = true;

  // 留一个坏路径比没有头像更糟，所以失败宁可什么都不存
  assert.strictEqual(await uploadAvatar('http://tmp/a.jpeg'), '');
  assert.strictEqual(uploads.length, 1);
});

test('上传 —— 云存储没回 fileID 也算失败', async () => {
  uploadResult = {};

  assert.strictEqual(await uploadAvatar('http://tmp/a.jpeg'), '');
});

test('上传 —— 本地模拟数据不传云存储，原样留着临时路径', async () => {
  runtime.setDataSource(DATA_SOURCE.MOCK);

  const result = await uploadAvatar('http://tmp/a.jpeg');
  assert.strictEqual(result, 'http://tmp/a.jpeg');
  assert.strictEqual(uploads.length, 0);
});
