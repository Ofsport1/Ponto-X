'use strict';
// Embute ícone e nome no .exe sem depender da ferramenta de assinatura do electron-builder
// (que exige permissão de link simbólico no Windows).
const path = require('path');
const { rcedit } = require('rcedit');

exports.default = async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const exe = path.join(context.appOutDir, `${name}.exe`);
  await rcedit(exe, {
    icon: path.join(__dirname, 'build', 'icon.ico'),
    'version-string': {
      ProductName: 'Ponto X - Delivery',
      FileDescription: 'Ponto X - Delivery',
      InternalName: 'Ponto X - Delivery',
      OriginalFilename: `${name}.exe`,
    },
  });
};
