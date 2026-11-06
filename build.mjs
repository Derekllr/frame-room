import {readFileSync, writeFileSync, mkdirSync, copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const code = file => read('src/' + file + '.mjs').replace(/^import .+;\n/gm, '').replace(/^export /gm, '');
const worker = ['core', 'image', 'worker'].map(code).join('\n');
const demo = JSON.parse(read('demo/credits.json')).map(({file, author, url}) => ({name:file, author, url}));
const template = read('src/index.html').replace('<!-- STYLES -->', () => '<style>\n' + read('src/style.css') + '\n</style>');
const app = ['core', 'image', 'zip', 'i18n', 'app'].map(code).join('\n');
const render = samples => {
  const js = 'const WORKER_SOURCE = ' + JSON.stringify(worker) + ';\nconst DEMO = ' + JSON.stringify(samples) + ';\n' + app;
  return template.replace('<!-- APP -->', () => '<script type="module">\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>');
};
const html = render(demo);
mkdirSync('dist/demo', {recursive:true});
for (const {name} of demo) copyFileSync('demo/' + name, 'dist/demo/' + name);
writeFileSync('dist/index.html', html);
writeFileSync('index.html', html);
const offlineArg = process.argv.indexOf('--offline');
if (offlineArg >= 0) {
  const path = process.argv[offlineArg + 1] || 'Frame-Room.html';
  writeFileSync(path, render(demo.map(sample => ({...sample, data:readFileSync('demo/' + sample.name).toString('base64')}))));
}
console.log('Built the GitHub Pages entry and dist/');
