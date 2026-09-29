# Ponto X — marca

Arte gerada com a ferramenta integrada image_gen em 28/09/2026.
Arquivo final: `assets/logo.png` (1254 × 1254 pixels).
Usada no cabeçalho, painel, favicon, Apple touch icon, manifest e Open Graph.
O PNG original é compartilhado por essas aplicações, com dimensões reais declaradas.

## Prompt final

Use case: logo-brand. Create one polished professional logo for the Brazilian burger takeaway Ponto X. Square 1024x1024 flat artwork ready to use as a website logo and mobile app icon, not a mockup. Brand text exactly "PONTO X" with PONTO and X on the same single baseline, and small clearly spaced "LANCHES" underneath. Strong carefully kerned bold condensed custom sans serif lettering, ivory PONTO and vivid warm red X. Above the wordmark a beautifully simplified geometric hamburger emblem in warm golden yellow with just a few strong deliberate lines, balanced and appetizing, not a cartoon emoji. Solid near-black background #111111. Centered compact composition, generous safe margin of 14 percent for app icon rounding, striking readable silhouette at small size. Premium contemporary local burger restaurant identity. Crisp clean vector-like edges, flat colors, refined spacing, restrained design. No gradients, no shadows, no photographs, no textures, no 3D, no thin circular borders, no slogans or additional text, no watermark. Deliver a single finished square logo.

## Verificação

- `node --test tests/access-vip.test.mjs`
- Os testes de marca (`store-brand.test.mjs`/`store-brand-browser.cjs`) do projeto original testavam a troca
  entre duas lojas no mesmo Worker; não fazem sentido aqui com uma loja só e não foram copiados. Se um teste
  de marca for necessário neste projeto, escrever um novo cobrindo só a Ponto X.
