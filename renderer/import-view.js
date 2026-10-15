// Importar → the Spotify account link (spotify-link.js): the playlists chosen there are copied to
// the YouTube Music account and kept up to date.
import { h } from './core.js';
import { tr } from './i18n.js';
import { spotifyLinkView } from './spotify-link.js';

export function importView() {
  const root = h('<div class="import"></div>');
  root.append(h(`<h1 class="page-title">${tr('Importar de Spotify')}</h1>`), spotifyLinkView());
  return root;
}
