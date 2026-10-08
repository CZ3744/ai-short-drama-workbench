import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { browserOsEnvironmentKey, captureBrowserOsEnvironment, edgeTestEnvironment } from '../../../../scripts/browser-test-environment.mjs';

describe('isolated Edge process environment', () => {
  it('carries only Windows directory identity and preserves the backend fixture environment', () => {
    const host = { USERPROFILE: 'C:\\Users\\example', LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local', APPDATA: 'C:\\Users\\example\\AppData\\Roaming', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\example', OPENAI_API_KEY: 'fixture-do-not-forward', GH_TOKEN: 'fixture-do-not-forward' };
    const source = { NODE_ENV: 'test', VIDEO_GENERATE_TEST_FIXTURE: 'C:\\Fixture', USERPROFILE: 'C:\\Fixture\\home', LOCALAPPDATA: 'C:\\Fixture\\home\\AppData', HOME: 'C:\\Fixture\\home', TMP: 'C:\\Fixture\\tmp', TEMP: 'C:\\Fixture\\tmp', PATH: 'system-tools', OPENAI_API_KEY: 'fixture-do-not-forward', HTTP_PROXY: 'fixture-do-not-forward', [browserOsEnvironmentKey]: captureBrowserOsEnvironment(host) };
    const before = structuredClone(source);
    const browserEnv = edgeTestEnvironment(source);
    assert.equal(browserEnv.USERPROFILE, host.USERPROFILE);
    assert.equal(browserEnv.LOCALAPPDATA, host.LOCALAPPDATA);
    assert.equal(browserEnv.HOME, source.HOME);
    assert.equal(browserEnv.TMP, source.TMP);
    assert.equal(browserEnv.TEMP, source.TEMP);
    assert.equal(browserEnv.PATH, source.PATH);
    assert.equal(browserEnv.OPENAI_API_KEY, undefined);
    assert.equal(browserEnv.GH_TOKEN, undefined);
    assert.equal(browserEnv.HTTP_PROXY, undefined);
    assert.equal(browserEnv[browserOsEnvironmentKey], undefined);
    assert.deepEqual(source, before);
  });

  it('revalidates nested-run metadata rather than accepting arbitrary browser variables', () => {
    assert.equal(process.env[browserOsEnvironmentKey], undefined, 'ordinary unit tests must not receive host browser metadata');
    const data = captureBrowserOsEnvironment({ [browserOsEnvironmentKey]: JSON.stringify({ USERPROFILE: 'C:\\Users\\example', OPENAI_API_KEY: 'fixture-do-not-forward', CHROME_USER_DATA_DIR: 'fixture-do-not-forward' }) });
    assert.deepEqual(JSON.parse(data), { USERPROFILE: 'C:\\Users\\example' });
    assert.throws(() => edgeTestEnvironment({ NODE_ENV: 'production' }), /isolated test fixture/);
  });

});
