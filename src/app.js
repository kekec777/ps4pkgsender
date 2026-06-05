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
const coverMapUrl = process.env.COVER_MAP_URL || 'https://raw.githubusercontent.com/hmn/ps4-imagemap/master/games.json';
const coverStoreRegions = (process.env.COVER_STORE_REGIONS || 'DK/da,GB/en,US/en,DE/de,SE/sv,NO/no')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

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
        message: 'No missing covers found',
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
        status: 'info',
        reason: `Could not load GitHub cover map, trying PlayStation Store fallback only: ${error.message}`
      });
    }

    for (const pkg of missing) {
      const titleId = extractTitleId(`${pkg.root} ${pkg.dir} ${pkg.name}`);

      if (!titleId) {
        results.push({
          package: pkg.name,
          status: 'skipped',
          reason: 'No CUSA title ID found in filename/folder'
        });
        continue;
      }

      const lookup = await findCoverUrl(titleId, coverMap);

      if (!lookup.url) {
        results.push({
          package: pkg.name,
          titleId,
          status: 'skipped',
          reason: lookup.reason || 'No cover URL found for this title ID'
        });
        continue;
      }

      try {
        const savedAs = await downloadCoverImage(lookup.url, pkg.imgname);

        results.push({
          package: pkg.name,
          titleId,
          status: 'downloaded',
          source: lookup.source,
          savedAs
        });
      } catch (error) {
        results.push({
          package: pkg.name,
          titleId,
          status: 'failed',
          source: lookup.source,
          reason: error.message
        });
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
      const pkgWithCover = rootPkgs.find((pkg) => fs.existsSync(path.join(coverImagesPath, pkg.imgname)));
      const folderImgname = (pkgWithCover || rootPkgs[0] || { imgname: 'folder.png' }).imgname;

      return {
        id: crypto.randomUUID(),
        root,
        count: rootPkgs.length,
        bytes,
        folderImgname,
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

  dirs.forEach((dir) => {
    dir.pkgs.forEach((pkg) => {
      const coverPath = path.join(coverImagesPath, pkg.imgname);

      if (!fs.existsSync(coverPath)) {
        missing.push({
          root: dir.root,
          dir: pkg.dir,
          name: pkg.name,
          imgname: pkg.imgname
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

async function findCoverUrl(titleId, coverMap) {
  if (coverMap && coverMap[titleId]) {
    return {
      url: coverMap[titleId],
      source: 'github-cover-map'
    };
  }

  const storeResult = await findCoverUrlFromPlayStationStore(titleId);

  if (storeResult.url) {
    return storeResult;
  }

  return {
    url: null,
    reason: storeResult.reason || 'Not found in GitHub cover map or PlayStation Store fallback'
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
      const images = Array.isArray(data.images) ? data.images : [];

      const image =
        images.find((item) => item && item.url && Number(item.type) === 1) ||
        images.find((item) => item && item.url && Number(item.type) === 2) ||
        images.find((item) => item && item.url);

      if (image && image.url) {
        return {
          url: image.url,
          source: `playstation-store-${country}-${language}`
        };
      }

      errors.push(`${country}/${language}: no images in response`);
    } catch (error) {
      errors.push(`${country}/${language}: ${error.message}`);
    }
  }

  return {
    url: null,
    reason: errors.length ? errors.join('; ') : 'No PlayStation Store regions configured'
  };
}

async function downloadCoverImage(imageUrl, imgname) {
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

  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`URL did not return an image (${contentType || 'unknown content type'})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const maxBytes = 10 * 1024 * 1024;

  if (buffer.length > maxBytes) {
    throw new Error('Image is larger than 10 MB');
  }

  fs.mkdirSync(coverImagesPath, { recursive: true });

  const safeImgname = path.basename(imgname).replace(/[^a-zA-Z0-9._ -]/g, '_');
  const targetPath = path.join(coverImagesPath, safeImgname);

  fs.writeFileSync(targetPath, buffer);

  return safeImgname;
}

function isValidHost(value) {
  if (!value || value.length > 253) return false;
  return /^(localhost|[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]|[a-fA-F0-9:]+)$/.test(value);
}
