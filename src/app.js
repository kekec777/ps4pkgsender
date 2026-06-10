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

function buildSearchTitle(root, name) {
  const rootTitle = cleanGameTitle(root);
  const nameTitle = cleanGameTitle(name);
  const combined = nameTitle.toLowerCase().startsWith(rootTitle.toLowerCase())
    ? nameTitle
    : `${rootTitle} ${nameTitle}`;

  return normalizeSearchTitle(combined);
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

app.post('/api/covers/download-missing', async (req, res) => {
  try {
    const dirs = flattenPkgs(getPkgs());
    const missing = getMissingCovers(dirs);

    if (missing.length === 0) {
      return res.json({
        message: 'No missing covers or thumbnails found',
        checked: 0,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        results: []
      });
    }

    let coverMap = {};
    const results = [];

    try {
      coverMap = await loadCoverMap();
    } catch (error) {
      results.push({
        package: 'cover-map',
        type: 'info',
        status: 'info',
        reason: `Could not load GitHub cover map, trying fallback searches only: ${error.message}`
      });
    }

    for (const item of missing) {
      const titleId = extractTitleId(item.lookupText);
      const lookup = await findCoverUrl(titleId, coverMap, item);

      if (!lookup.url) {
        results.push({
          package: item.package || item.name,
          type: item.type,
          targetName: item.targetName,
          titleId,
          searchTitle: item.searchTitle,
          status: 'skipped',
          reason: lookup.reason || 'No cover URL found'
        });
        continue;
      }

      try {
        const targetDir = item.type === 'thumbnail' ? thumbnailImagesPath : coverImagesPath;
        const savedAs = await downloadImageToFolder(lookup.url, item.targetName, targetDir);

        results.push({
          package: item.package || item.name,
          type: item.type,
          titleId,
          searchTitle: item.searchTitle,
          status: 'downloaded',
          source: lookup.source,
          savedAs,
          savedTo: item.type === 'thumbnail' ? 'thumbnail' : 'images'
        });
      } catch (error) {
        let fallbackSaved = false;

        if (item.searchTitle && !String(lookup.source || '').includes('playstation-store-search')) {
          const fallbackLookup = await findCoverUrlByStoreSearch(item.searchTitle);

          if (fallbackLookup.url) {
            try {
              const targetDir = item.type === 'thumbnail' ? thumbnailImagesPath : coverImagesPath;
              const savedAs = await downloadImageToFolder(fallbackLookup.url, item.targetName, targetDir);

              results.push({
                package: item.package || item.name,
                type: item.type,
                titleId,
                searchTitle: item.searchTitle,
                status: 'downloaded',
                source: `${fallbackLookup.source} after ${lookup.source} failed`,
                savedAs,
                savedTo: item.type === 'thumbnail' ? 'thumbnail' : 'images'
              });

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

              results.push({
                package: item.package || item.name,
                type: item.type,
                titleId,
                searchTitle: item.searchTitle,
                status: 'downloaded',
                source: `${orbisLookup.source} after ${lookup.source} failed`,
                savedAs,
                savedTo: item.type === 'thumbnail' ? 'thumbnail' : 'images'
              });

              fallbackSaved = true;
            } catch (orbisError) {
              results.push({
                package: item.package || item.name,
                type: item.type,
                targetName: item.targetName,
                titleId,
                searchTitle: item.searchTitle,
                status: 'failed',
                source: `${lookup.source}; final fallback ${orbisLookup.source}`,
                reason: `${error.message}; final fallback failed: ${orbisError.message}`
              });

              fallbackSaved = true;
            }
          }
        }

        if (!fallbackSaved) {
          results.push({
            package: item.package || item.name,
            type: item.type,
            targetName: item.targetName,
            titleId,
            searchTitle: item.searchTitle,
            status: 'failed',
            source: lookup.source,
            reason: error.message
          });
        }
      }
    }

    const downloaded = results.filter((item) => item.status === 'downloaded').length;
    const skipped = results.filter((item) => item.status === 'skipped').length;
    const failed = results.filter((item) => item.status === 'failed').length;
    const info = results.filter((item) => item.status === 'info').length;

    res.json({
      message: `Cover download finished: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`,
      checked: missing.length,
      downloaded,
      skipped,
      failed,
      info,
      results
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
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

function extractTitleId(value) {
  const match = String(value || '').match(/CUSA\d{5}/i);
  return match ? match[0].toUpperCase() : null;
}

function extractLegacyTitleId(value) {
  const match = String(value || '').match(/\b(SLUS|SCUS|SCES|SLES)\D?(\d{5})\b/i);
  return match ? `${match[1].toUpperCase()}${match[2]}` : null;
}

function extractContentId(value) {
  const match = String(value || '').match(/\b[A-Z]{2}\d{4}-[A-Z0-9]{4,10}\d{5}_00-[A-Z0-9_]+\b/i);
  return match ? match[0].toUpperCase() : null;
}

async function loadCoverMap() {
  const response = await fetch(coverMapUrl, {
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
  const contentId = extractContentId(item.lookupText);
  const legacyTitleId = extractLegacyTitleId(item.lookupText);
  const searchTitle = item.searchTitle || cleanGameTitle(item.lookupText);

  if (titleId && coverMap && coverMap[titleId]) {
    return {
      url: coverMap[titleId],
      source: 'github-cover-map'
    };
  }

  if (titleId) {
    const storeResult = await findCoverUrlFromPlayStationStore(titleId);

    if (storeResult.url) {
      return storeResult;
    }

    const serialTitleResult = await findCoverUrlFromSerialStationTitleId(titleId);

    if (serialTitleResult.url) {
      return serialTitleResult;
    }
  }

  if (contentId) {
    const contentResult = await findCoverUrlFromContentId(contentId);

    if (contentResult.url) {
      return contentResult;
    }
  }

  if (legacyTitleId) {
    const serialResult = await findCoverUrlFromSerialStation(legacyTitleId);

    if (serialResult.url) {
      return serialResult;
    }
  }

  if (searchTitle) {
    const serialSearchResult = await findCoverUrlFromSerialStationSearch(searchTitle);

    if (serialSearchResult.url) {
      return serialSearchResult;
    }

    const storeSearchResult = await findCoverUrlByStoreSearch(searchTitle);

    if (storeSearchResult.url) {
      return storeSearchResult;
    }
  }

  if (titleId && coverEnableOrbisPatches) {
    const orbisResult = await findCoverUrlFromOrbisPatches(titleId);

    if (orbisResult.url) {
      return orbisResult;
    }
  }

  return {
    url: null,
    reason: [
      titleId ? `CUSA lookup failed for ${titleId}` : 'No CUSA title ID',
      contentId ? `content ID lookup failed for ${contentId}` : null,
      legacyTitleId ? `legacy title ID lookup failed for ${legacyTitleId}` : null,
      searchTitle ? `SerialStation/title search failed for "${searchTitle}"` : 'no usable title text',
      coverEnableOrbisPatches ? 'ORBISPatches final fallback failed' : 'ORBISPatches disabled'
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
      const response = await fetch(url, {
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
      const response = await fetch(url, {
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
    const response = await fetch(`https://orbispatches.com/${encodeURIComponent(titleId)}`, {
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


async function findCoverUrlFromSerialStationTitleId(titleId) {
  const match = String(titleId || '').match(/^([A-Z]{4})(\d{5})$/i);
  if (!match) return { url: null, reason: 'invalid SerialStation title ID' };

  const url = `https://serialstation.com/titles/${match[1].toUpperCase()}/${match[2]}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ps4-pkg-sender'
      }
    });

    if (!response.ok) {
      return { url: null, reason: `serialstation title HTTP ${response.status}` };
    }

    const html = await response.text();

    // First try image from SerialStation if available.
    const imageUrl = findImageUrlInHtml(html);
    if (imageUrl) {
      return {
        url: imageUrl,
        source: 'serialstation-title-image'
      };
    }

    // If SerialStation has no image, use its Content ID entries to ask PlayStation metadata.
    const contentIds = Array.from(
      html.matchAll(/\b[A-Z]{2}\d{4}-[A-Z0-9]{4,10}\d{5}_00-[A-Z0-9_]+\b/gi)
    ).map((match) => match[0].toUpperCase());

    for (const contentId of [...new Set(contentIds)]) {
      const contentResult = await findCoverUrlFromContentId(contentId);

      if (contentResult.url) {
        return {
          ...contentResult,
          source: `serialstation-content-id-${contentResult.source}`
        };
      }
    }

    return { url: null, reason: 'serialstation title had no usable image/content ID' };
  } catch (error) {
    return { url: null, reason: `serialstation title: ${error.message}` };
  }
}

async function findCoverUrlFromSerialStationSearch(searchTitle) {
  try {
    const response = await fetch(`https://serialstation.com/titles/?name=${encodeURIComponent(searchTitle)}`, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ps4-pkg-sender'
      }
    });

    if (!response.ok) {
      return { url: null, reason: `serialstation search HTTP ${response.status}` };
    }

    const html = await response.text();

    const titleMatch = html.match(/\/titles\/([A-Z]{4})\/(\d{5})/i);

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

    const imageUrl = findImageUrlInHtml(html);
    if (imageUrl) {
      return {
        url: imageUrl,
        source: 'serialstation-search-image'
      };
    }

    return { url: null, reason: 'serialstation search had no usable result' };
  } catch (error) {
    return { url: null, reason: `serialstation search: ${error.message}` };
  }
}

async function findCoverUrlFromSerialStation(legacyTitleId) {
  const match = legacyTitleId.match(/^([A-Z]{4})(\d{5})$/);
  if (!match) return { url: null, reason: 'invalid legacy title ID' };

  const url = `https://serialstation.com/titles/${match[1]}/${match[2]}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ps4-pkg-sender'
      }
    });

    if (!response.ok) {
      return { url: null, reason: `serialstation HTTP ${response.status}` };
    }

    const html = await response.text();
    const imageUrl = findImageUrlInHtml(html);

    if (imageUrl) {
      return {
        url: imageUrl,
        source: 'serialstation'
      };
    }

    return { url: null, reason: 'serialstation had no usable image' };
  } catch (error) {
    return { url: null, reason: `serialstation: ${error.message}` };
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
        const response = await fetch(url, {
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

        errors.push(`${country}/${language}: no image in search result`);
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

function findImageUrlInObject(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return /^https?:\/\/.+\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(value) ? value : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrlInObject(item);
      if (found) return found;
    }

    return null;
  }

  if (typeof value === 'object') {
    if (value.url && /^https?:\/\//i.test(value.url)) {
      return value.url;
    }

    const preferredKeys = ['images', 'media', 'cover', 'image', 'thumbnail', 'gameContentTypesList', 'included'];

    for (const key of preferredKeys) {
      if (value[key]) {
        const found = findImageUrlInObject(value[key]);
        if (found) return found;
      }
    }

    for (const key of Object.keys(value)) {
      const found = findImageUrlInObject(value[key]);
      if (found) return found;
    }
  }

  return null;
}

function findImageUrlInHtml(html) {
  const source = String(html || '');

  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<img[^>]+src=["']([^"']+)["']/i,
    /<a[^>]+href=["']([^"']*(?:serialstation\/media|linodeobjects\.com)[^"']*)["']/i,
    /(?:href|src)=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/i,
    /(https?:\/\/[^"'<> ]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'<> ]*)?)/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);

    if (match && match[1]) {
      let imageUrl = decodeHtmlEntities(match[1]);

      if (imageUrl.startsWith('//')) {
        imageUrl = `https:${imageUrl}`;
      }

      if (imageUrl.startsWith('/')) {
        imageUrl = `https://serialstation.com${imageUrl}`;
      }

      if (/^https?:\/\//i.test(imageUrl)) {
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

  const response = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'ps4-pkg-sender'
    }
  });

  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
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
