// Google Meet does not offer a public API for live captions, so the bot reads them from the
// page. Meet's CSS class names are obfuscated and change from time to time. Each list below
// is tried in order, and the caption reader also has structural fallbacks (avatar image +
// name + text) for when none of the class names match.
//
// If captions stop showing up after a Meet update: join a meeting in Chrome, turn on
// captions, right-click a caption -> Inspect, and add the new selectors at the top of these lists.

export const SELECTORS = {
  // The panel that holds the live captions.
  captionContainers: [
    'div[role="region"][aria-label*="aption" i]',
    'div[jsname="dsyhDe"]',
    'div.a4cQT',
    'div[jscontroller="KPn5nb"]',
  ],
  // One element per speaker turn inside that panel.
  captionBlocks: ['div.nMcdL', 'div.TBMuR', 'div.CNusmb'],
  // Speaker name inside a block.
  speakerName: ['.NWpY1d', '.KcIKyf', '.zs7s8d', '.YTbUzc'],
  // Caption text inside a block.
  captionText: ['.ygicle', '.VbkSUe', '.iTTPOb', 'div[jsname="tgaKEf"]'],
};

// Text that tells us what state the Meet page is in (the bot forces English UI with ?hl=en).
export const PAGE_TEXT = {
  waiting: /asking to be let in|please wait until a meeting host|someone in the call (needs to|will) let you in|you'll join the call when someone lets you in|waiting for (the )?host/i,
  noResponse: /no one responded to your request|nobody responded|request timed out/i,
  denied: /denied your request|request to join was (denied|declined)|you can'?t join this call|someone in the call denied/i,
  blocked: /you can'?t join this video call|you cannot join this video call/i,
  removed: /you('ve| have) been removed|removed you from the (meeting|call)/i,
  invalid: /check your meeting code|invalid video call name|meeting code.{0,40}(isn'?t|is not) valid|this video call link is invalid/i,
  ended: /(the )?(meeting|call) has ended|this call has ended|you left the meeting|you('ve| have) left the (meeting|call)|return to home screen/i,
  signIn: /sign in to join|you must be signed in|sign in with your google account|use your google account/i,
  alone: /you'?re the only one here/i,
};
