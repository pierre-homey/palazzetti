'use strict';

const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const widget = path.join(root, 'widgets', 'stove-dashboard');

async function render(mode) {
  const dark = mode === 'dark';
  const card = dark ? '#242120' : '#ffffff';
  const primary = dark ? '#f5f3f2' : '#171717';
  const muted = dark ? '#8f8986' : '#aaa8ad';
  const orange = '#e87532';
  const blue = '#4b96c8';
  const shadow = dark ? '#00000030' : '#5c566018';
  const svg = `
    <svg width="1024" height="1024" viewBox="0 0 460 460" xmlns="http://www.w3.org/2000/svg">
      <rect x="51" y="132" width="358" height="196" rx="23" fill="${shadow}"/>
      <rect x="51" y="126" width="358" height="196" rx="23" fill="${card}"/>

      <!-- Store previews use abstract shapes instead of text, numbers or units. -->
      <rect x="83" y="202" width="166" height="38" rx="12" fill="${primary}"/>
      <rect x="273" y="220" width="60" height="20" rx="8" fill="${muted}"/>

      <g transform="translate(361 151)" fill="none" stroke="${orange}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2c1 8-5 10-5 17a10 10 0 0 0 20 0c0-6-3-11-8-16 1 7-3 9-7 12 1-5-1-9-5-12"/>
      </g>

      <rect x="83" y="284" width="48" height="8" rx="4" fill="${orange}"/>
      <rect x="143" y="284" width="48" height="8" rx="4" fill="${blue}"/>
      <rect x="203" y="284" width="48" height="8" rx="4" fill="${muted}"/>
    </svg>`;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(path.join(widget, `preview-${mode}.png`));
}

Promise.all([render('light'), render('dark')]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
