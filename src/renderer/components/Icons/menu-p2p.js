import Icon from '@/components/Icons/Icon'

/* Interconnect: two peers (large behind, small in front) framed by diagonal
   rounded crop corners — the two ends of a link brought into one mark.
   Corners inherit the group stroke (paths opt out of the inherited fill so
   the open hooks stay open); bodies are filled; same 24px grid and
   stroke language as the other rail icons. */
Icon.register({
  'menu-p2p': {
    'width': 24,
    'height': 24,
    'raw': `
      <path fill="none" d="M2,9.5 V6.5 A4.5,4.5 0 0 1 6.5,2 H9.5"/>
      <path fill="none" d="M22,14.5 V17.5 A4.5,4.5 0 0 1 17.5,22 H14.5"/>
      <circle fill="currentColor" stroke="none" cx="15.2" cy="7.2" r="3"/>
      <path fill="currentColor" stroke="none" d="M10.4,17.4 V16 A4.8,4.8 0 0 1 20,16 V17.4 Z"/>
      <circle fill="currentColor" stroke="none" cx="8.3" cy="12.7" r="2.4"/>
      <path fill="currentColor" stroke="none" d="M4.5,20.5 V19.9 A3.9,3.9 0 0 1 12.3,19.9 V20.5 Z"/>`,
    'g': {
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2'
    }
  }
})
