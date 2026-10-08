import Icon from '@/components/Icons/Icon'

/* Two linked nodes: the P2P group page. Same 24px grid and single-path
   style as the other rail icons. */
Icon.register({
  'menu-p2p': {
    'width': 24,
    'height': 24,
    'paths': [{
      'fill': 'none',
      'stroke': 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'd': 'M8.5 7.5 L15.5 16.5'
    }, {
      'd': 'M10.9 3.6 a3.4 3.4 0 1 0 0 6.8 a3.4 3.4 0 1 0 0 -6.8 Z M13.1 13.6 a3.4 3.4 0 1 0 0 6.8 a3.4 3.4 0 1 0 0 -6.8 Z'
    }]
  }
})
