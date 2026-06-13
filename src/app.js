const express = require('express');
const morgan = require('morgan');
const mustacheExpress = require('mustache-express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const filesizeModule = require('filesize');
const formatFileSize = typeof filesizeModule === 'function' ? filesizeModule : filesizeModule.filesize;

const port = Number(process.env.PORT || 7777);
const staticFilesPath = path.resolve(process.env.STATIC_FILES || './files');
const localIp = process.env.LOCALIP || 'localhost';
const coverImagesPath = path.join(__dirname, 'public', 'images');
const thumbnailImagesPath = path.join(__dirname, 'public', 'thumbnail');
const coverMapUrl = process.env.COVER_MAP_URL || 'https://raw.githubusercontent.com/hmn/ps4-imagemap/master/games.json';
const coverStoreRegions = (process.env.COVER_STORE_REGIONS || 'DK/da,GB/en,US/en,DE/de,SE/sv,NO/no')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const coverSearchRegions = (process.env.COVER_SEARCH_REGIONS || process.env.COVER_STORE_REGIONS || 'DK/da,GB/en,US/en,DE/de,SE/sv,NO/no')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const coverEnableOrbisPatches = String(process.env.COVER_ENABLE_ORBISPATCHES || 'true').toLowerCase() === 'true';

function encodePublicImageUrl(folder, filename) {
  return `/public/${encodeURIComponent(folder)}/${String(filename)
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function safeFileBase(value) {
  return String(value || 'folder')
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180) || 'folder';
}

function cleanGameTitle(value) {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/_/g, ' ')
    .replace(/\./g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(CUSA\d{5}|SLUS\d{5}|SCUS\d{5}|SCES\d{5}|SLES\d{5})\b/gi, ' ')
    .replace(/\b[A-Z]{2}\d{4}-[A-Z0-9_-]+_00-[A-Z0-9_]+\b/gi, ' ')
    .replace(/\b(v|ver|version)?\s*\d+(\.\d+)+\b/gi, ' ')
    .replace(/\b(BACKPORT|OPOISSO\d+|DUPLEX|FUGAZI|PS4|PKG|A0100|V0100|STORE|TOOLS)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function normalizeSearchTitle(value) {
  const words = String(value || '')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const normalized = [];
  const seen = new Set();

  for (const word of words) {
    const key = word.toLowerCase();

    if (!seen.has(key)) {
      normalized.push(word);
      seen.add(key);
    }
  }

  return normalized.join(' ');
}


const coverTitleAliases = {
  CUSA00667: 'SingStar Mega Hits',
  CUSA00501: 'SingStar Ultimate Party',
  SCUS97399: 'God of War',
  SCES54206: 'God of War II',
  SLUS22184: 'Resident Evil Code Veronica X',
  CUSA00667: 'SingStar Mega Hits',
  CUSA00501: 'SingStar Ultimate Party'
};

function romanizeTitleNumber(value) {
  return String(value || '')
    .replace(/\bGod\s*Of\s*War\s*2\b/gi, 'God of War II')
    .replace(/\bGod\s*Of\s*War2\b/gi, 'God of War II')
    .replace(/\bGOW2\b/gi, 'God of War II')
    .replace(/\bGOW\b/gi, 'God of War')
    .replace(/\bVeronicaX\b/gi, 'Code Veronica X');
}

function getBestAliasTitle(value) {
  const ids = extractAllTitleIds(value);

  for (const id of ids) {
    if (coverTitleAliases[id]) {
      return coverTitleAliases[id];
    }
  }

  return null;
}

function cleanCoverSearchTitle(value) {
  const alias = getBestAliasTitle(value);
  if (alias) return alias;

  let text = String(value || '');

  // Remove filename extension and common scene/update/version/FW noise.
  text = text
    .replace(/\.pkg$/i, ' ')
    .replace(/\bUPDATE\b/gi, ' ')
    .replace(/\bBACKPORT\b/gi, ' ')
    .replace(/\bDUPLEX\b/gi, ' ')
    .replace(/\bOPOISSO893\b/gi, ' ')
    .replace(/\bDLPSGAME\.COM\b/gi, ' ')
    .replace(/\bFXD(?:v)?\d+(?:\.\d+)?\b/gi, ' ')
    .replace(/\bFW\d+\b/gi, ' ')
    .replace(/\bV(?:ersion)?\s*\d+(?:[._]\d+)?\b/gi, ' ')
    .replace(/\bv\d+(?:[._]\d+)?\b/gi, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^\)]*Sporty[^\)]*\)/gi, ' ');

  // Remove content IDs like UP9000-SCUS97399_00-SCUS973990000001-A0100-V0100.
  text = text.replace(/[A-Z]{2}\d{4}-[A-Z0-9]{4,10}\d{5}_00-[A-Z0-9_]+(?:-[A-Z]\d{4}-V\d{4})?/gi, ' ');

  // Remove title IDs after they were used for direct lookup.
  text = text.replace(/\bCUSA\d{5}\b/gi, ' ');
  text = text.replace(/\b(SLUS|SCUS|SCES|SLES|SLPS|SLPM|NPUJ|NPUI|NPEF|NPUG|NPEG|NPUB|NPEB|NPHG|ULUS|ULES|UCUS|UCES)[\s._-]*\d{5}\b/gi, ' ');

  // Turn separators into spaces, then apply common short-name expansions.
  text = text.replace(/[._-]+/g, ' ');
  text = romanizeTitleNumber(text);

  // Remove duplicate words caused by filenames like GOW__... after GOW expansion.
  text = text
    .replace(/\b(God of War)(\s+\1)+\b/gi, '$1')
    .replace(/\b(Resident Evil)(\s+\1)+\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}


function buildSearchTitle(root, pkgName = '') {
  const alias = getBestAliasTitle(`${root} ${pkgName}`);
  if (alias) return alias;

  const cleanedPkg = cleanCoverSearchTitle(pkgName);
  const cleanedRoot = cleanCoverSearchTitle(root);

  // Prefer the package name when it has useful text. Otherwise use folder/root.
  const candidate = cleanedPkg.length >= 3 ? cleanedPkg : cleanedRoot;

  return candidate || cleanGameTitle(`${root} ${pkgName}`);
}


function safeLocalImageFilename(value) {
  const filename = path.basename(String(value || 'cover.jpg'));

  if (!filename || filename === '.' || filename === '..') {
    return 'cover.jpg';
  }

  // Keep the original filename so the missing-file check matches exactly.
  // Only remove characters that are unsafe for local files.
  return filename
    .replace(/[\/\\:*?"<>|]/g, '_')
    .slice(0, 220);
}

function imageExists(targetDir, filename) {
  return fs.existsSync(path.join(targetDir, safeLocalImageFilename(filename)));
}


function imageExistsWithLegacyAlias(targetDir, filename) {
  if (imageExists(targetDir, filename)) {
    return true;
  }

  const parsed = path.parse(String(filename || ''));
  const legacyName = `${safeFileBase(parsed.name)}${parsed.ext || '.jpg'}`;

  return fs.existsSync(path.join(targetDir, legacyName));
}


function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=')
    .replace(/&#x3F;/g, '?')
    .replace(/&#x26;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}


const app = express();
let currentPS4ipadr = process.env.PS4IP || 'localhost';

app.use(morgan('combined'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/css', express.static(path.join(__dirname, '../node_modules/@fortawesome/fontawesome-free/css')));
app.use('/webfonts', express.static(path.join(__dirname, '../node_modules/@fortawesome/fontawesome-free/webfonts')));
app.use('/css', express.static(path.join(__dirname, '../node_modules/bootstrap/dist/css')));
app.use('/js', express.static(path.join(__dirname, '../node_modules/bootstrap/dist/js')));
app.use('/css', express.static(path.join(__dirname, 'views/css')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/pkgfiles', express.static(staticFilesPath, { dotfiles: 'deny', fallthrough: false }));

app.engine('html', mustacheExpress());
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'views'));


const coverFetchTimeoutMs = Number.parseInt(process.env.COVER_FETCH_TIMEOUT_MS || '7000', 10);
const coverItemTimeoutMs = Number.parseInt(process.env.COVER_ITEM_TIMEOUT_MS || '45000', 10);
const originalFetch = globalThis.fetch.bind(globalThis);

async function fetchWithTimeout(url, options = {}, timeoutMs = coverFetchTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await originalFetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;

  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}


app.get('/', (req, res, next) => {
  try {
    const dirs = flattenPkgs(getPkgs());
    const totalPkgs = dirs.reduce((sum, dir) => sum + dir.count, 0);
    const totalBytes = dirs.reduce((sum, dir) => sum + dir.bytes, 0);

    res.render('index', {
      dirs,
      hasDirs: dirs.length > 0,
      totalDirs: dirs.length,
      totalPkgs,
      totalSize: formatFileSize(totalBytes)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ps4ip', (req, res) => {
  res.json({ variable: currentPS4ipadr });
});

app.post('/api/ps4ip', (req, res) => {
  const newPS4ipadr = String(req.body.newPS4ipadr || '').trim();

  if (!isValidHost(newPS4ipadr)) {
    return res.status(400).json({ message: 'Invalid PS4 IP/host' });
  }

  currentPS4ipadr = newPS4ipadr;
  res.json({ message: 'PS4 IP address updated', variable: currentPS4ipadr });
});

app.get('/api/covers/missing', (req, res, next) => {
  try {
    const dirs = flattenPkgs(getPkgs());
    const missing = getMissingCovers(dirs);

    res.json({
      missingCount: missing.length,
      missing
    });
  } catch (error) {
    next(error);
  }
});

function getCoverResultCounts(results = []) {
  return {
    downloaded: results.filter((item) => item.status === 'downloaded').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    info: results.filter((item) => item.status === 'info').length
  };
}

function buildCoverDownloadResponse(checked, results = []) {
  const counts = getCoverResultCounts(results);

  return {
    message: checked === 0
      ? 'No missing covers or thumbnails found'
      : `Cover download finished: ${counts.downloaded} downloaded, ${counts.skipped} skipped, ${counts.failed} failed`,
    checked,
    downloaded: counts.downloaded,
    skipped: counts.skipped,
    failed: counts.failed,
    info: counts.info,
    results
  };
}

async function runMissingCoverDownload(onProgress = null) {
  const emit = (payload) => {
    if (typeof onProgress === 'function') {
      onProgress(payload);
    }
  };

  const dirs = flattenPkgs(getPkgs());
  const missing = getMissingCovers(dirs);

  emit({
    kind: 'start',
    checked: missing.length,
    counts: { downloaded: 0, skipped: 0, failed: 0, info: 0 }
  });

  if (missing.length === 0) {
    const emptyResult = buildCoverDownloadResponse(0, []);
    emit({ kind: 'done', result: emptyResult });
    return emptyResult;
  }

  let coverMap = {};
  const results = [];

  try {
    coverMap = await loadCoverMap();
  } catch (error) {
    const infoItem = {
      package: 'cover-map',
      type: 'info',
      status: 'info',
      reason: `Could not load GitHub cover map, trying fallback searches only: ${error.message}`
    };

    results.push(infoItem);
    emit({
      kind: 'item-result',
      index: 0,
      total: missing.length,
      item: infoItem,
      counts: getCoverResultCounts(results)
    });
  }

  for (let i = 0; i < missing.length; i += 1) {
    const item = missing[i];
    const titleId = extractTitleId(item.lookupText);

    emit({
      kind: 'item-start',
      index: i + 1,
      total: missing.length,
      item: {
        package: item.package || item.name,
        type: item.type,
        titleId,
        searchTitle: item.searchTitle
      },
      counts: getCoverResultCounts(results)
    });

    let resultItem = null;
    let lookup = null;

    try {
      lookup = await withTimeout(
        findCoverUrl(titleId, coverMap, item),
        coverItemTimeoutMs,
        `Timed out after ${coverItemTimeoutMs}ms while searching ${item.type} - ${item.package || item.name}`
      );
    } catch (error) {
      let timeoutRecovered = false;

      if (titleId && isCusaTitleId(titleId) && coverEnableOrbisPatches) {
        try {
          emit({
            kind: 'item-start',
            index: i + 1,
            total: missing.length,
            item: {
              package: item.package || item.name,
              type: item.type,
              titleId,
              searchTitle: item.searchTitle,
              fallback: 'Trying ORBISPatches after timeout'
            },
            counts: getCoverResultCounts(results)
          });

          const orbisLookup = await withTimeout(
            findCoverUrlFromOrbisPatches(titleId),
            Math.min(coverItemTimeoutMs, 15000),
            `ORBISPatches fallback timed out for ${titleId}`
          );

          if (orbisLookup.url) {
            const targetDir = item.type === 'thumbnail' ? thumbnailImagesPath : coverImagesPath;
            const savedAs = await downloadImageToFolder(orbisLookup.url, item.targetName, targetDir);

            resultItem = {
              package: item.package || item.name,
              type: item.type,
              titleId,
              searchTitle: item.searchTitle,
              status: 'downloaded',
              source: `${orbisLookup.source} after item timeout`,
              savedAs,
              savedTo: item.type === 'thumbnail' ? 'thumbnail' : 'images'
            };

            results.push(resultItem);
            timeoutRecovered = true;
          }
        } catch (orbisError) {
          // Fall through to skipped item below.
        }
      }

      if (!timeoutRecovered) {
        resultItem = {
          package: item.package || item.name,
          type: item.type,
          targetName: item.targetName,
          titleId,
          searchTitle: item.searchTitle,
          status: 'skipped',
          shortReason: 'Timed out. Moving to next item.',
          reason: `${error.message}. Moving to next item.`
        };

        results.push(resultItem);
      }

      emit({
        kind: 'item-result',
        index: i + 1,
        total: missing.length,
        item: resultItem,
        counts: getCoverResultCounts(results)
      });
      continue;
    }

    if (!lookup.url) {
      resultItem = {
        package: item.package || item.name,
        type: item.type,
        targetName: item.targetName,
        titleId,
        searchTitle: item.searchTitle,
        status: 'skipped',
        shortReason: 'No usable cover found after all sources',
        reason: lookup.reason || 'No cover URL found'
      };
      results.push(resultItem);
      emit({
        kind: 'item-result',
        index: i + 1,
        total: missing.length,
        item: resultItem,
        counts: getCoverResultCounts(results)
      });
      continue;
    }

    try {
      const targetDir = item.type === 'thumbnail' ? thumbnailImagesPath : coverImagesPath;
      const savedAs = await downloadImageToFolder(lookup.url, item.targetName, targetDir);

      resultItem = {
        package: item.package || item.name,
        type: item.type,
        titleId,
        searchTitle: item.searchTitle,
        status: 'downloaded',
        source: lookup.source,
        savedAs,
        savedTo: item.type === 'thumbnail' ? 'thumbnail' : 'images'
      };

      results.push(resultItem);
    } catch (error) {
      let fallbackSaved = false;

      if (item.searchTitle && !String(lookup.source || '').includes('playstation-store-search')) {
        const fallbackLookup = await findCoverUrlByStoreSearch(item.searchTitle);

        if (fallbackLookup.url) {
          try {
            const targetDir = item.type === 'thumbnail' ? thumbnailImagesPath : coverImagesPath;
            const savedAs = await downloadImageToFolder(fallbackLookup.url, item.targetName, targetDir);

            resultItem = {
              package: item.package || item.name,
              type: item.type,
              titleId,
              searchTitle: item.searchTitle,
              status: 'downloaded',
              source: `${fallbackLookup.source} after ${lookup.source} failed`,
              savedAs,
              savedTo: item.type === 'thumbnail' ? 'thumbnail' : 'images'
            };

            results.push(resultItem);
            fallbackSaved = true;
          } catch (fallbackError) {
            // Continue to ORBISPatches final fallback below.
          }
        }
      }

      if (!fallbackSaved && titleId && coverEnableOrbisPatches && !String(lookup.source || '').includes('orbispatches')) {
        const orbisLookup = await findCoverUrlFromOrbisPatches(titleId);

        if (orbisLookup.url) {
          try {
            const targetDir = item.type === 'thumbnail' ? thumbnailImagesPath : coverImagesPath;
            const savedAs = await downloadImageToFolder(orbisLookup.url, item.targetName, targetDir);

            resultItem = {
              package: item.package || item.name,
              type: item.type,
              titleId,
              searchTitle: item.searchTitle,
              status: 'downloaded',
              source: `${orbisLookup.source} after ${lookup.source} failed`,
              savedAs,
              savedTo: item.type === 'thumbnail' ? 'thumbnail' : 'images'
            };

            results.push(resultItem);
            fallbackSaved = true;
          } catch (orbisError) {
            resultItem = {
              package: item.package || item.name,
              type: item.type,
              targetName: item.targetName,
              titleId,
              searchTitle: item.searchTitle,
              status: 'failed',
              source: `${lookup.source}; final fallback ${orbisLookup.source}`,
              reason: `${error.message}; final fallback failed: ${orbisError.message}`
            };

            results.push(resultItem);
            fallbackSaved = true;
          }
        }
      }

      if (!fallbackSaved) {
        resultItem = {
          package: item.package || item.name,
          type: item.type,
          targetName: item.targetName,
          titleId,
          searchTitle: item.searchTitle,
          status: 'failed',
          source: lookup.source,
          reason: error.message
        };

        results.push(resultItem);
      }
    }

    emit({
      kind: 'item-result',
      index: i + 1,
      total: missing.length,
      item: resultItem,
      counts: getCoverResultCounts(results)
    });
  }

  const finalResult = buildCoverDownloadResponse(missing.length, results);
  emit({ kind: 'done', result: finalResult });
  return finalResult;
}

app.post('/api/covers/download-missing', async (req, res) => {
  try {
    const result = await runMissingCoverDownload();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/covers/download-missing/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  let closed = false;
  const keepAlive = setInterval(() => {
    if (!closed) {
      res.write(': ping\n\n');
    }
  }, 15000);

  req.on('close', () => {
    closed = true;
  });

  const send = (payload) => {
    if (!closed) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  try {
    await runMissingCoverDownload(send);
  } catch (error) {
    send({ kind: 'error', message: error.message });
  } finally {
    clearInterval(keepAlive);
    if (!closed) {
      res.end();
    }
  }
});

app.post('/install', async (req, res) => {
  try {
    const filepath = resolvePkgPath(req.body.filepath);
    const result = await ps4Install(filepath);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Server error');
});

app.listen(port, () => {
  console.log(`PS4 PKG sender listening on port ${port} serving files from ${staticFilesPath}`);
});

function flattenPkgs(pkgs) {
  return Object.keys(pkgs)
    .sort((a, b) => a.localeCompare(b))
    .map((root) => {
      const rootPkgs = pkgs[root].sort((a, b) => a.name.localeCompare(b.name));
      rootPkgs.forEach((pkg) => {
        pkg.displayName = pkg.displayName || `${pkg.name}.pkg`;
        pkg.shortDisplayName = pkg.shortDisplayName || pkg.displayName;
      });
      const bytes = rootPkgs.reduce((sum, pkg) => sum + pkg.bytes, 0);
      const firstPkg = rootPkgs[0] || { imgname: 'folder.png' };
      const folderThumbname = `${safeFileBase(root)}.jpg`;

      return {
        id: crypto.randomUUID(),
        root,
        count: rootPkgs.length,
        bytes,
        folderImgname: firstPkg.imgname,
        folderThumbname,
        folderThumbUrl: encodePublicImageUrl('thumbnail', folderThumbname),
        folderFallbackThumbUrl: encodePublicImageUrl('thumbnail', 'folder.png'),
        pkgs: rootPkgs
      };
    });
}

function getPkgs() {
  const filelist = {};

  if (!fs.existsSync(staticFilesPath)) {
    return filelist;
  }

  function walkSync(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });

    files.forEach((file) => {
      const filepath = path.join(dir, file.name);

      if (file.isDirectory()) {
        walkSync(filepath);
        return;
      }

      if (!file.isFile() || path.extname(file.name).toLowerCase() !== '.pkg') {
        return;
      }

      const stat = fs.statSync(filepath);
      const relativePath = path.relative(staticFilesPath, filepath);
      const dirname = path.dirname(relativePath) === '.' ? 'Root' : path.dirname(relativePath);
      const root = dirname.split(path.sep)[0] || 'Root';
      const name = path.basename(filepath);

      if (!filelist[root]) filelist[root] = [];

      filelist[root].push({
        filepath,
        relativePath,
        dir: dirname,
        name,
        imgname: `${path.parse(filepath).name}.jpg`,
        imgUrl: encodePublicImageUrl('images', `${path.parse(filepath).name}.jpg`),
        size: formatFileSize(stat.size),
        bytes: stat.size,
        searchText: `${root} ${dirname} ${name}`.toLowerCase()
      });
    });
  }

  walkSync(staticFilesPath);
  return filelist;
}

function resolvePkgPath(filepath) {
  const requestedPath = path.resolve(String(filepath || ''));
  const relative = path.relative(staticFilesPath, requestedPath);

  if (!requestedPath || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid package path');
  }

  if (path.extname(requestedPath).toLowerCase() !== '.pkg' || !fs.existsSync(requestedPath)) {
    throw new Error('Package not found');
  }

  return requestedPath;
}

function encodeRelativeUrl(filepath) {
  return path.relative(staticFilesPath, filepath)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');
}

function ps4Install(filepath) {
  return new Promise((resolve, reject) => {
    const pkgUri = `http://${localIp}:${port}/pkgfiles/${encodeRelativeUrl(filepath)}`;
    const ps4ApiUri = `http://${currentPS4ipadr}:12800/api/install`;
    const payload = JSON.stringify({ type: 'direct', packages: [pkgUri] });

    execFile('curl', ['-sS', '-v', ps4ApiUri, '--data', payload], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`Install request failed: ${stderr || err.message}`));
      }

      resolve({
        message: `Install request sent for ${path.basename(filepath)}`,
        package: path.basename(filepath),
        stdout,
        stderr
      });
    });
  });
}


function getMissingCovers(dirs) {
  const missing = [];
  const addedFolderThumbs = new Set();

  dirs.forEach((dir) => {
    const firstPkg = dir.pkgs[0];

    if (!imageExistsWithLegacyAlias(thumbnailImagesPath, dir.folderThumbname) && firstPkg && !addedFolderThumbs.has(dir.root)) {
      missing.push({
        type: 'thumbnail',
        root: dir.root,
        dir: firstPkg.dir,
        name: `${dir.root} folder thumbnail`,
        package: firstPkg.name,
        targetName: dir.folderThumbname,
        lookupText: `${dir.root} ${firstPkg.dir} ${firstPkg.name}`,
        searchTitle: buildSearchTitle(dir.root, firstPkg.name)
      });

      addedFolderThumbs.add(dir.root);
    }

    dir.pkgs.forEach((pkg) => {
      if (!imageExistsWithLegacyAlias(coverImagesPath, pkg.imgname)) {
        missing.push({
          type: 'image',
          root: dir.root,
          dir: pkg.dir,
          name: pkg.name,
          package: pkg.name,
          targetName: pkg.imgname,
          lookupText: `${dir.root} ${pkg.dir} ${pkg.name}`,
          searchTitle: buildSearchTitle(dir.root, pkg.name)
        });
      }
    });
  });

  return missing;
}


function isBadSerialStationImageUrl(imageUrl) {
  const value = String(imageUrl || '').toLowerCase();

  return (
    !value ||
    value.includes('/favicon') ||
    value.includes('apple-touch-icon') ||
    value.includes('android-chrome') ||
    value.includes('mstile') ||
    value.includes('/logo') ||
    value.includes('playstation.svg') ||
    value.includes('ps.svg') ||
    value.includes('xbox.svg') ||
    value.includes('nintendo.svg')
  );
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=')
    .replace(/&#x3F;/g, '?')
    .replace(/&#x26;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeImageUrl(imageUrl, baseUrl = 'https://serialstation.com') {
  let value = decodeHtmlEntities(String(imageUrl || '').trim());

  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (value.startsWith('/')) {
    value = `${baseUrl}${value}`;
  }

  return value;
}

function isProbablyImageUrl(imageUrl) {
  const value = normalizeImageUrl(imageUrl).toLowerCase();

  if (!/^https?:\/\//i.test(value)) {
    return false;
  }

  if (isBadSerialStationImageUrl(value)) {
    return false;
  }

  if (
    value.includes('/store/api/') ||
    value.includes('/chihiro-api/') ||
    value.includes('/container/') ||
    value.includes('/titlecontainer/') ||
    value.includes('/concept/')
  ) {
    return false;
  }

  return (
    /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(value) ||
    value.includes('image.api.playstation.com') ||
    value.includes('store.playstation.com/store/api/chihiro/00_09_000/image') ||
    value.includes('/media/') ||
    value.includes('/images/')
  );
}

function absolutizeUrl(url, baseUrl = 'https://serialstation.com') {
  return normalizeImageUrl(url, baseUrl);
}

function extractSerialStationLinks(html) {
  const links = [];
  const source = String(html || '');
  const regex = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const url = absolutizeUrl(match[1]);

    if (url.includes('serialstation.com/titles/') || url.includes('serialstation.com/games/')) {
      links.push(url);
    }
  }

  return [...new Set(links)];
}

function extractContentIdsFromHtml(html) {
  return [...new Set(
    Array.from(
      String(html || '').matchAll(/\b[A-Z]{2}\d{4}-[A-Z0-9_-]+_00-[A-Z0-9_]+\b/gi)
    ).map((match) => match[0].toUpperCase())
  )];
}

function getObjectKeyScore(key) {
  const normalized = String(key || '').toLowerCase();

  if (['url', 'src', 'imageurl', 'thumbnailurl', 'previewurl'].includes(normalized)) return 5;
  if (normalized.includes('image')) return 4;
  if (normalized.includes('thumbnail')) return 4;
  if (normalized.includes('cover')) return 4;
  if (normalized.includes('poster')) return 3;
  if (normalized.includes('media')) return 2;

  return 0;
}


function extractAllTitleIds(value) {
  const text = String(value || '');
  const ids = [];

  // PS4 CUSA IDs. Use custom boundaries so IDs after underscores are detected.
  for (const match of text.matchAll(/(^|[^A-Z0-9])(CUSA\d{5})(?=$|[^A-Z0-9])/gi)) {
    ids.push(match[2].toUpperCase());
  }

  // PS1/PS2/PSP/PSN style SerialStation IDs.
  // This also matches filenames like Castlevania_SLUS00067.pkg and Metal_Gear_Solid_2_SLUS20144.pkg.
  for (const match of text.matchAll(/(^|[^A-Z0-9])(SLUS|SCUS|SCES|SLES|SLPS|SLPM|NPUJ|NPUI|NPEF|NPUG|NPEG|NPUB|NPEB|NPHG|ULUS|ULES|UCUS|UCES)[\s._-]*(\d{5})(?=$|[^A-Z0-9])/gi)) {
    ids.push(`${match[2].toUpperCase()}${match[3]}`);
  }

  return [...new Set(ids)];
}


function isCusaTitleId(titleId) {
  return /^CUSA\d{5}$/i.test(String(titleId || ''));
}

function isSerialStationTitleId(titleId) {
  return /^(CUSA|SLUS|SCUS|SCES|SLES|SLPS|SLPM|NPUJ|NPUI|NPEF|NPUG|NPEG|NPUB|NPEB|NPHG|ULUS|ULES|UCUS|UCES)\d{5}$/i.test(String(titleId || ''));
}


function extractTitleId(value) {
  const ids = extractAllTitleIds(value);
  return ids.find((id) => isCusaTitleId(id)) || ids[0] || null;
}

function extractLegacyTitleId(value) {
  const ids = extractAllTitleIds(value);
  return ids.find((id) => !isCusaTitleId(id)) || null;
}

function extractContentId(value) {
  const match = String(value || '').match(/\b[A-Z]{2}\d{4}-[A-Z0-9_-]+_00-[A-Z0-9_]+\b/i);
  return match ? match[0].toUpperCase() : null;
}


async function loadCoverMap() {
  const response = await fetchWithTimeout(coverMapUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ps4-pkg-sender'
    }
  });

  if (!response.ok) {
    throw new Error(`Could not download cover map: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Cover map is not a valid JSON object');
  }

  return data;
}

async function findCoverUrl(titleId, coverMap, item = {}) {
  const lookupText = item.lookupText || '';
  const allTitleIds = extractAllTitleIds(lookupText);
  const cusaTitleIds = allTitleIds.filter((id) => isCusaTitleId(id));
  const serialTitleIds = allTitleIds.filter((id) => isSerialStationTitleId(id));
  const contentId = extractContentId(lookupText);
  const searchTitle = item.searchTitle || cleanGameTitle(lookupText);
  const tried = [];

  // 1. GitHub cover map and PlayStation Store for CUSA IDs.
  for (const cusaId of cusaTitleIds) {
    if (coverMap && coverMap[cusaId]) {
      return {
        url: coverMap[cusaId],
        source: 'github-cover-map'
      };
    }

    const storeResult = await findCoverUrlFromPlayStationStore(cusaId);
    tried.push(`PlayStation Store ${cusaId}: ${storeResult.reason || (storeResult.url ? 'ok' : 'no result')}`);

    if (storeResult.url) {
      return storeResult;
    }
  }

  // 2. SerialStation by any supported title ID, not only CUSA.
  for (const serialId of serialTitleIds) {
    const serialTitleResult = await findCoverUrlFromSerialStationTitleId(serialId);
    tried.push(`SerialStation ${serialId}: ${serialTitleResult.reason || (serialTitleResult.url ? 'ok' : 'no result')}`);

    if (serialTitleResult.url) {
      return serialTitleResult;
    }
  }

  // 3. ORBISPatches early fallback for CUSA IDs.
  // Some titles are found quickly in ORBISPatches, while generic title searches can be slow.
  // Trying ORBIS here prevents CUSA items from timing out before ORBIS is reached.
  if (coverEnableOrbisPatches) {
    for (const cusaId of cusaTitleIds) {
      const orbisResult = await findCoverUrlFromOrbisPatches(cusaId);
      tried.push(`ORBISPatches early ${cusaId}: ${orbisResult.reason || (orbisResult.url ? 'ok' : 'no result')}`);

      if (orbisResult.url) {
        return orbisResult;
      }
    }
  }

  // 4. Content ID lookup, if the filename includes one.
  if (contentId) {
    const contentResult = await findCoverUrlFromContentId(contentId);
    tried.push(`Content ID ${contentId}: ${contentResult.reason || (contentResult.url ? 'ok' : 'no result')}`);

    if (contentResult.url) {
      return contentResult;
    }
  }

  // 4. If this is an old PS1/PS2/PSP ID, try the clean alias title before the noisy filename title.
  const aliasSearchTitle = cleanCoverSearchTitle(lookupText);

  if (aliasSearchTitle && aliasSearchTitle !== searchTitle) {
    const aliasSerialSearchResult = await findCoverUrlFromSerialStationSearch(aliasSearchTitle);
    tried.push(`SerialStation alias search "${aliasSearchTitle}": ${aliasSerialSearchResult.reason || (aliasSerialSearchResult.url ? 'ok' : 'no result')}`);

    if (aliasSerialSearchResult.url) {
      return aliasSerialSearchResult;
    }

    const aliasStoreSearchResult = await findCoverUrlByStoreSearch(aliasSearchTitle);
    tried.push(`PlayStation alias search "${aliasSearchTitle}": ${aliasStoreSearchResult.reason || (aliasStoreSearchResult.url ? 'ok' : 'no result')}`);

    if (aliasStoreSearchResult.url) {
      return aliasStoreSearchResult;
    }
  }

  // 5. SerialStation title search, then PlayStation Store title search.
  if (searchTitle) {
    const serialSearchResult = await findCoverUrlFromSerialStationSearch(searchTitle);
    tried.push(`SerialStation title search "${searchTitle}": ${serialSearchResult.reason || (serialSearchResult.url ? 'ok' : 'no result')}`);

    if (serialSearchResult.url) {
      return serialSearchResult;
    }

    const storeSearchResult = await findCoverUrlByStoreSearch(searchTitle);
    tried.push(`PlayStation title search "${searchTitle}": ${storeSearchResult.reason || (storeSearchResult.url ? 'ok' : 'no result')}`);

    if (storeSearchResult.url) {
      return storeSearchResult;
    }

    const cleanerSearchTitle = cleanCoverSearchTitle(searchTitle);

    if (cleanerSearchTitle && cleanerSearchTitle !== searchTitle) {
      const cleanerStoreResult = await findCoverUrlByStoreSearch(cleanerSearchTitle);
      tried.push(`PlayStation clean title search "${cleanerSearchTitle}": ${cleanerStoreResult.reason || (cleanerStoreResult.url ? 'ok' : 'no result')}`);

      if (cleanerStoreResult.url) {
        return cleanerStoreResult;
      }
    }
  }

  return {
    url: null,
    reason: [
      allTitleIds.length ? `title IDs checked: ${allTitleIds.join(', ')}` : 'No title ID found',
      searchTitle ? `search title: "${searchTitle}"` : 'no usable title text',
      tried.length ? tried.join('; ') : null
    ].filter(Boolean).join('; ')
  };
}


async function findCoverUrlFromPlayStationStore(titleId) {
  const errors = [];

  for (const region of coverStoreRegions) {
    const [country, language] = region.split('/');
    if (!country || !language) continue;

    const url = `https://store.playstation.com/store/api/chihiro/00_09_000/titlecontainer/${encodeURIComponent(country)}/${encodeURIComponent(language)}/999/${encodeURIComponent(titleId)}_00`;

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ps4-pkg-sender'
        }
      });

      if (!response.ok) {
        errors.push(`${country}/${language}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const imageUrl = findImageUrlInObject(data);

      if (imageUrl) {
        return {
          url: imageUrl,
          source: `playstation-store-${country}-${language}`
        };
      }

      errors.push(`${country}/${language}: no image`);
    } catch (error) {
      errors.push(`${country}/${language}: ${error.message}`);
    }
  }

  return {
    url: null,
    reason: errors.join('; ')
  };
}

async function findCoverUrlFromContentId(contentId) {
  const errors = [];

  for (const region of coverStoreRegions) {
    const [country, language] = region.split('/');
    if (!country || !language) continue;

    const url = `https://store.playstation.com/store/api/chihiro/00_09_000/container/${encodeURIComponent(country)}/${encodeURIComponent(language)}/999/${encodeURIComponent(contentId)}`;

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ps4-pkg-sender'
        }
      });

      if (!response.ok) {
        errors.push(`${country}/${language}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const imageUrl = findImageUrlInObject(data);

      if (imageUrl) {
        return {
          url: imageUrl,
          source: `playstation-store-content-${country}-${language}`
        };
      }

      errors.push(`${country}/${language}: no image`);
    } catch (error) {
      errors.push(`${country}/${language}: ${error.message}`);
    }
  }

  return {
    url: null,
    reason: errors.join('; ')
  };
}

async function findCoverUrlFromOrbisPatches(titleId) {
  try {
    const response = await fetchWithTimeout(`https://orbispatches.com/${encodeURIComponent(titleId)}`, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ps4-pkg-sender'
      }
    });

    if (!response.ok) {
      return { url: null, reason: `orbispatches HTTP ${response.status}` };
    }

    const html = await response.text();

    // Best source from ORBISPatches is the Content ID because it can be used
    // against PlayStation/Sony metadata endpoints.
    const contentMatch = html.match(/\b[A-Z]{2}\d{4}-CUSA\d{5}_00-[A-Z0-9_]+\b/i);

    if (contentMatch) {
      const contentResult = await findCoverUrlFromContentId(contentMatch[0].toUpperCase());

      if (contentResult.url) {
        return {
          ...contentResult,
          source: `orbispatches-content-id-${contentResult.source}`
        };
      }
    }

    // If PlayStation Store metadata fails, use the visible ORBISPatches image.
    // ORBISPatches often uses webp CDN images and may not always return a useful
    // content-type header, so downloadImageToFolder validates the actual bytes too.
    const imageUrl = findImageUrlInHtml(html);

    if (imageUrl) {
      return {
        url: imageUrl,
        source: 'orbispatches-direct-image'
      };
    }

    return { url: null, reason: 'orbispatches had no usable content ID or image' };
  } catch (error) {
    return { url: null, reason: `orbispatches: ${error.message}` };
  }
}


async function findCoverUrlFromSerialStationTitleId(titleId, visited = new Set()) {
  const match = String(titleId || '').match(/^([A-Z]{4})(\d{5})$/i);
  if (!match) return { url: null, reason: 'invalid SerialStation title ID' };

  const normalizedTitleId = `${match[1].toUpperCase()}${match[2]}`;
  const url = `https://serialstation.com/titles/${match[1].toUpperCase()}/${match[2]}`;

  if (visited.has(url)) {
    return { url: null, reason: 'serialstation title already checked' };
  }

  visited.add(url);

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ps4-pkg-sender'
      }
    });

    if (!response.ok) {
      return { url: null, reason: `serialstation title HTTP ${response.status}` };
    }

    const html = await response.text();

    const imageUrl = findImageUrlInHtml(html);
    if (imageUrl) {
      return {
        url: imageUrl,
        source: `serialstation-title-image-${normalizedTitleId}`
      };
    }

    const contentIds = extractContentIdsFromHtml(html);

    for (const contentId of contentIds) {
      const contentResult = await findCoverUrlFromContentId(contentId);

      if (contentResult.url) {
        return {
          ...contentResult,
          source: `serialstation-content-id-${normalizedTitleId}-${contentResult.source}`
        };
      }
    }

    const links = extractSerialStationLinks(html);

    for (const link of links) {
      if (link.includes('/games/')) {
        const gameResult = await findCoverUrlFromSerialStationGamePage(link, normalizedTitleId, visited);

        if (gameResult.url) {
          return gameResult;
        }
      }
    }

    return { url: null, reason: `serialstation title ${normalizedTitleId} had no usable image/content ID/game image` };
  } catch (error) {
    return { url: null, reason: `serialstation title ${normalizedTitleId}: ${error.message}` };
  }
}


async function findCoverUrlFromSerialStationGamePage(gameUrl, originalTitleId, visited = new Set()) {
  if (visited.has(gameUrl)) {
    return { url: null, reason: 'serialstation game already checked' };
  }

  visited.add(gameUrl);

  try {
    const response = await fetchWithTimeout(gameUrl, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ps4-pkg-sender'
      }
    });

    if (!response.ok) {
      return { url: null, reason: `serialstation game HTTP ${response.status}` };
    }

    const html = await response.text();

    const imageUrl = findImageUrlInHtml(html);
    if (imageUrl) {
      return {
        url: imageUrl,
        source: 'serialstation-game-image'
      };
    }

    const contentIds = extractContentIdsFromHtml(html);

    for (const contentId of contentIds) {
      const contentResult = await findCoverUrlFromContentId(contentId);

      if (contentResult.url) {
        return {
          ...contentResult,
          source: `serialstation-game-content-id-${contentResult.source}`
        };
      }
    }

    const originalNumber = String(originalTitleId || '').replace(/^[A-Z]+/i, '');
    const titleLinks = extractSerialStationLinks(html)
      .filter((link) => link.includes('/titles/'))
      .filter((link) => !originalNumber || link.includes(originalNumber));

    for (const titleLink of titleLinks) {
      const titleMatch = titleLink.match(/\/titles\/([A-Z]{4})\/(\d{5})/i);

      if (!titleMatch) continue;

      const linkedTitleId = `${titleMatch[1].toUpperCase()}${titleMatch[2]}`;

      if (linkedTitleId === originalTitleId) continue;

      const titleResult = await findCoverUrlFromSerialStationTitleId(linkedTitleId, visited);

      if (titleResult.url) {
        return {
          ...titleResult,
          source: `serialstation-linked-title-${linkedTitleId}-${titleResult.source}`
        };
      }
    }

    return { url: null, reason: 'serialstation game page had no usable image/content ID/title image' };
  } catch (error) {
    return { url: null, reason: `serialstation game: ${error.message}` };
  }
}

async function findCoverUrlFromSerialStationSearch(searchTitle) {
  try {
    const response = await fetchWithTimeout(`https://serialstation.com/titles/?name=${encodeURIComponent(searchTitle)}`, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ps4-pkg-sender'
      }
    });

    if (!response.ok) {
      return { url: null, reason: `serialstation search HTTP ${response.status}` };
    }

    const html = await response.text();
    const links = extractSerialStationLinks(html);

    for (const link of links) {
      const titleMatch = link.match(/\/titles\/([A-Z]{4})\/(\d{5})/i);

      if (titleMatch) {
        const titleId = `${titleMatch[1].toUpperCase()}${titleMatch[2]}`;
        const result = await findCoverUrlFromSerialStationTitleId(titleId);

        if (result.url) {
          return {
            ...result,
            source: `serialstation-search-${result.source}`
          };
        }
      }
    }

    for (const link of links) {
      if (link.includes('/games/')) {
        const result = await findCoverUrlFromSerialStationGamePage(link, '', new Set());

        if (result.url) {
          return {
            ...result,
            source: `serialstation-search-${result.source}`
          };
        }
      }
    }

    return { url: null, reason: 'serialstation search had no usable title/game result' };
  } catch (error) {
    return { url: null, reason: `serialstation search: ${error.message}` };
  }
}


async function findCoverUrlByStoreSearch(searchTitle) {
  const errors = [];

  for (const region of coverSearchRegions) {
    const [country, language] = region.split('/');
    if (!country || !language) continue;

    const urls = [
      `https://store.playstation.com/store/api/chihiro/00_09_000/search/${encodeURIComponent(country)}/${encodeURIComponent(language)}/999/${encodeURIComponent(searchTitle)}`,
      `https://store.playstation.com/chihiro-api/search/${encodeURIComponent(country)}/${encodeURIComponent(language)}/999/${encodeURIComponent(searchTitle)}`
    ];

    for (const url of urls) {
      try {
        const response = await fetchWithTimeout(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'ps4-pkg-sender'
          }
        });

        if (!response.ok) {
          errors.push(`${country}/${language}: HTTP ${response.status}`);
          continue;
        }

        const data = await response.json();
        const imageUrl = findImageUrlInObject(data);

        if (imageUrl) {
          return {
            url: imageUrl,
            source: `playstation-store-search-${country}-${language}`
          };
        }

        errors.push(`${country}/${language}: search returned no usable image URL`);
      } catch (error) {
        errors.push(`${country}/${language}: ${error.message}`);
      }
    }
  }

  return {
    url: null,
    reason: errors.join('; ')
  };
}

function normalizeImageUrl(imageUrl, baseUrl = 'https://serialstation.com') {
  let value = decodeHtmlEntities(String(imageUrl || '').trim());

  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (value.startsWith('/')) {
    value = `${baseUrl}${value}`;
  }

  return value;
}

function isProbablyImageUrl(imageUrl) {
  const value = normalizeImageUrl(imageUrl).toLowerCase();

  if (!/^https?:\/\//i.test(value)) {
    return false;
  }

  if (isBadSerialStationImageUrl(value)) {
    return false;
  }

  // Do not treat PlayStation Store API/product JSON URLs as images.
  if (
    value.includes('/store/api/') ||
    value.includes('/chihiro-api/') ||
    value.includes('/container/') ||
    value.includes('/titlecontainer/') ||
    value.includes('/concept/')
  ) {
    return false;
  }

  return (
    /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(value) ||
    value.includes('image.api.playstation.com') ||
    value.includes('store.playstation.com/store/api/chihiro/00_09_000/image') ||
    value.includes('/media/') ||
    value.includes('/images/')
  );
}

function getObjectKeyScore(key) {
  const normalized = String(key || '').toLowerCase();

  if (['url', 'src', 'imageurl', 'thumbnailurl', 'previewurl'].includes(normalized)) return 5;
  if (normalized.includes('image')) return 4;
  if (normalized.includes('thumbnail')) return 4;
  if (normalized.includes('cover')) return 4;
  if (normalized.includes('poster')) return 3;
  if (normalized.includes('media')) return 2;

  return 0;
}


function findImageUrlInObject(value, keyHint = '') {
  if (!value) return null;

  if (typeof value === 'string') {
    return isProbablyImageUrl(value) ? normalizeImageUrl(value) : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrlInObject(item, keyHint);
      if (found) return found;
    }

    return null;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([keyA], [keyB]) => getObjectKeyScore(keyB) - getObjectKeyScore(keyA));

    for (const [key, item] of entries) {
      if (typeof item === 'string' && getObjectKeyScore(key) > 0 && isProbablyImageUrl(item)) {
        return normalizeImageUrl(item);
      }
    }

    const preferredKeys = [
      'images',
      'image',
      'media',
      'cover',
      'thumbnail',
      'thumbnailUrl',
      'imageUrl',
      'previewUrl',
      'gameContentTypesList',
      'included'
    ];

    for (const key of preferredKeys) {
      if (value[key]) {
        const found = findImageUrlInObject(value[key], key);
        if (found) return found;
      }
    }

    for (const [key, item] of entries) {
      const found = findImageUrlInObject(item, key);
      if (found) return found;
    }
  }

  return null;
}


function findImageUrlInHtml(html) {
  const source = String(html || '');

  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,
    /<a[^>]+href=["']([^"']*(?:serialstation\/media|linodeobjects\.com|\.jpg|\.jpeg|\.png|\.webp)[^"']*)["']/gi,
    /<img[^>]+src=["']([^"']+)["']/gi,
    /(?:href|src)=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/gi,
    /(https?:\/\/[^"'<> ]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'<> ]*)?)/gi
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(source)) !== null) {
      if (!match[1]) continue;

      const imageUrl = normalizeImageUrl(match[1]);

      if (isProbablyImageUrl(imageUrl)) {
        return imageUrl;
      }
    }
  }

  return null;
}


function looksLikeImageBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false;

  // JPG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }

  // WebP: RIFF....WEBP
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true;
  }

  return false;
}

function urlLooksLikeImage(imageUrl) {
  return /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(String(imageUrl || ''));
}


async function downloadImageToFolder(imageUrl, imgname, targetDir) {
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error('Cover URL is not http/https');
  }

  const response = await fetchWithTimeout(imageUrl, {
    headers: {
      'User-Agent': 'ps4-pkg-sender'
    }
  });

  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';

  if (contentType.toLowerCase().includes('application/json')) {
    const data = await response.json();
    const nestedImageUrl = findImageUrlInObject(data);

    if (nestedImageUrl && nestedImageUrl !== imageUrl) {
      return downloadImageToFolder(nestedImageUrl, imgname, targetDir);
    }

    throw new Error(`URL returned JSON but no usable image URL was found (${contentType})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const maxBytes = 10 * 1024 * 1024;

  if (buffer.length > maxBytes) {
    throw new Error('Image is larger than 10 MB');
  }

  const isImageContentType = contentType.toLowerCase().startsWith('image/');
  const isImageByUrl = urlLooksLikeImage(imageUrl);
  const isImageByBytes = looksLikeImageBuffer(buffer);

  if (!isImageContentType && !isImageByUrl && !isImageByBytes) {
    throw new Error(`URL did not return an image (${contentType || 'unknown content type'})`);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const safeImgname = safeLocalImageFilename(imgname);
  const targetPath = path.join(targetDir, safeImgname);

  fs.writeFileSync(targetPath, buffer);

  return safeImgname;
}

async function downloadCoverImage(imageUrl, imgname) {
  return downloadImageToFolder(imageUrl, imgname, coverImagesPath);
}


function isValidHost(value) {
  if (!value || value.length > 253) return false;
  return /^(localhost|[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]|[a-fA-F0-9:]+)$/.test(value);
}
