const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const rootDir = path.resolve(__dirname, '..');
const inputPath = path.join(rootDir, 'SYSTEM_DOCUMENTATION.md');
const outputPath = path.join(rootDir, 'SYSTEM_DOCUMENTATION.pdf');
const isWatchMode = process.argv.includes('--watch');

function generatePdf() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const markdown = fs.readFileSync(inputPath, 'utf8');
  const lines = markdown.split(/\r?\n/);
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: 'Despatch Scale Labels System Documentation',
      Author: 'Despatch Scale Labels',
    },
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  function writeHeading(text, level) {
    const sizes = { 1: 20, 2: 16, 3: 14, 4: 12 };
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(sizes[level] || 12).fillColor('#0b2239').text(text, {
      align: 'left',
    });
    doc.moveDown(0.25);
  }

  function writeBody(text) {
    doc.font('Helvetica').fontSize(11).fillColor('#111111').text(text, {
      align: 'left',
      lineGap: 2,
    });
  }

  function writeBullet(text) {
    doc.font('Helvetica').fontSize(11).fillColor('#111111').text(`- ${text}`, {
      indent: 12,
      lineGap: 2,
    });
  }

  writeHeading('Despatch Scale Labels System Documentation', 1);
  writeBody(`Generated on ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      doc.moveDown(0.35);
      continue;
    }

    if (line.startsWith('#### ')) {
      writeHeading(line.replace(/^####\s+/, ''), 4);
      continue;
    }

    if (line.startsWith('### ')) {
      writeHeading(line.replace(/^###\s+/, ''), 3);
      continue;
    }

    if (line.startsWith('## ')) {
      writeHeading(line.replace(/^##\s+/, ''), 2);
      continue;
    }

    if (line.startsWith('# ')) {
      writeHeading(line.replace(/^#\s+/, ''), 1);
      continue;
    }

    if (line.startsWith('- ')) {
      writeBullet(line.replace(/^-\s+/, ''));
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      writeBody(line);
      continue;
    }

    writeBody(line);
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      console.log(`PDF generated: ${outputPath}`);
      resolve();
    });
    stream.on('error', reject);
  });
}

let generationInProgress = false;
let pendingRegeneration = false;

async function runGeneration() {
  if (generationInProgress) {
    pendingRegeneration = true;
    return;
  }

  generationInProgress = true;
  try {
    await generatePdf();
  } catch (error) {
    console.error(`PDF generation failed: ${error.message}`);
  } finally {
    generationInProgress = false;
    if (pendingRegeneration) {
      pendingRegeneration = false;
      await runGeneration();
    }
  }
}

async function start() {
  await runGeneration();

  if (!isWatchMode) {
    return;
  }

  console.log(`Watching for changes: ${inputPath}`);
  let debounceTimer = null;

  fs.watch(inputPath, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runGeneration();
    }, 250);
  });
}

start();
