/** Directory metadata for an Edge child process, never credentials or browser profile data. */
export const browserOsEnvironmentKey = 'VIDEO_GENERATE_BROWSER_OS_ENV';
const windowsDirectories = new Set(['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH']);
const browserBaseKeys = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|HOME|TMP|TEMP|TMPDIR)$/i;

function selectDirectories(source) {
  const result = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (windowsDirectories.has(name) && typeof value === 'string' && value) result[name] = value;
  }
  return result;
}

export function captureBrowserOsEnvironment(source = process.env) {
  // The clean-install runner may already have carried the original OS directories
  // through another isolated process. Revalidate the keys at every boundary.
  if (source[browserOsEnvironmentKey]) {
    return JSON.stringify(selectDirectories(JSON.parse(source[browserOsEnvironmentKey])));
  }
  return JSON.stringify(selectDirectories(source));
}

export function edgeTestEnvironment(source = process.env) {
  if (source.NODE_ENV !== 'test' || !source.VIDEO_GENERATE_TEST_FIXTURE) {
    throw new Error('Edge test environment requires an isolated test fixture');
  }
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (browserBaseKeys.test(key) && typeof value === 'string') result[key] = value;
  }
  // Edge's Windows Known Folder/default-profile checks need the OS account's
  // directory identity. Playwright still owns a new --user-data-dir under TMP.
  Object.assign(result, JSON.parse(captureBrowserOsEnvironment(source)));
  return result;
}
