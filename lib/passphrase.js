/**
 * Proposal passphrases. Ported from the Roberts repo (assets/js/passphrase.js,
 * the same 256 words), and moved to the server: the passphrase is generated
 * once, at first publish, and reused for every revision behind the same link.
 *
 * A published proposal's ciphertext can be taken away and guessed at offline,
 * so the passphrase is the whole of the defence. Five words from 256 plus three
 * digits is about 50 bits — and every guess also costs 600,000 PBKDF2 rounds.
 * Words are short, unambiguous and survive being read down a phone.
 */
import { randomInt } from 'node:crypto';

export const WORDS = (
  'able,acorn,actor,adept,album,alert,alley,amber,anchor,angle,ankle,apple,april,apron,arbor,arrow,ash,aspen,atlas,attic,' +
  'autumn,axle,bacon,badge,bagel,baker,balcony,bamboo,banjo,barley,basin,basket,batch,beacon,beagle,beam,bean,bear,beech,belt,' +
  'bench,berry,birch,bishop,bison,blend,bloom,board,bolt,bonus,boot,borough,bottle,boulder,bramble,branch,brass,bread,brick,bridge,' +
  'bronze,brook,broom,brush,bubble,bucket,buffer,bugle,bunker,burrow,button,cabin,cable,cactus,camel,candle,canoe,canvas,canyon,cape,' +
  'carbon,cargo,carpet,carrot,castle,cedar,cellar,chalk,charm,cherry,chess,chime,cider,cinder,circus,cliff,cloak,clover,cobalt,cocoa,' +
  'coffee,comet,compass,copper,coral,cotton,cove,crane,crate,crayon,creek,crest,crown,crystal,cube,cypress,dagger,dahlia,daisy,dancer,' +
  'dapple,dawn,delta,denim,desert,diamond,dingo,dolphin,domino,donkey,dragon,drift,drum,dune,dusk,eagle,ember,emerald,engine,envoy,' +
  'escort,ether,fable,falcon,fathom,feather,fennel,fern,ferry,fiddle,filter,finch,flag,flame,flint,floral,flute,forest,forge,fossil,' +
  'fountain,fox,frost,galaxy,gallery,garden,garnet,gate,gecko,ginger,glacier,glider,granite,grape,gravel,grove,guitar,gully,gypsum,hammer,' +
  'harbour,harvest,hawk,hazel,heather,hedge,helm,heron,hickory,hollow,honey,horizon,hornet,hostel,hurdle,indigo,ingot,ivory,jackal,jade,' +
  'jasmine,jetty,jigsaw,jungle,juniper,kayak,kernel,kettle,keystone,kite,koala,lagoon,lantern,lark,laurel,lava,ledge,lemon,lentil,leopard,' +
  'lever,lichen,lilac,linen,lobby,locket,lodge,lotus,lumber,lunar,lychee,magnet,mahogany,mallet,mango,manor,maple,marble,marina,marsh,' +
  'meadow,melon,mercury,meteor,mimosa,mineral,mint,mirror,mohair,monsoon,moss,mountain,mulberry,museum,mustard,nectar').split(',');

const WORD_COUNT = 5;

/** e.g. "harbour-lantern-copper-marsh-quartz-482". */
export function newPassphrase() {
  const out = [];
  for (let i = 0; i < WORD_COUNT; i += 1) out.push(WORDS[randomInt(WORDS.length)]);
  out.push(String(randomInt(1000)).padStart(3, '0'));
  return out.join('-');
}

export const PASSPHRASE_BITS = Math.round(WORD_COUNT * Math.log2(WORDS.length) + Math.log2(1000));
