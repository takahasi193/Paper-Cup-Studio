/**
 * Deterministic synthetic visual-novel fixtures (L1 -> L6, Easy -> Expert)
 * and strict executable Engine / VM Consumer Simulators for the Paper Cup Reverser Benchmark.
 *
 * Every binary container, cipher, bytecode VM, and minimal x86-32 PE executable is generated
 * deterministically using Node built-ins + Paper Cup's own CP932/GBK codecs (zero external deps,
 * zero copyrighted game files).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodeText, normalizeGbkCompatText } from '../../src/vn/profile.js';
import type {
  BenchTaskSpec,
  ConsumerVerificationInput,
  ConsumerVerificationResult,
  GroundTruthTextEntry,
} from './types.js';

/* ========================= Shared Helpers ========================= */

const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
  0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
}

function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

function decodeStrict(buf: Buffer, encoding: string): string {
  const norm = encoding.trim().toLowerCase();
  if (norm === 'gbk' || norm === 'cp936' || norm === 'gb18030') {
    return new TextDecoder('gbk', { fatal: true }).decode(buf);
  }
  if (norm === 'cp932' || norm === 'shift-jis' || norm === 'shift_jis') {
    return new TextDecoder('shift_jis', { fatal: true }).decode(buf);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

function normalizeExpectedForEncoding(text: string, encoding: string): string {
  const norm = encoding.trim().toLowerCase();
  if (norm === 'gbk' || norm === 'cp936') {
    return normalizeGbkCompatText(text);
  }
  return text;
}

function writePapercupToml(workspaceDir: string): void {
  fs.writeFileSync(
    path.join(workspaceDir, 'papercup.toml'),
    '[vn.localization]\nsource_lang = "ja"\ntarget_lang = "zh"\nnarrative_pov = "source"\n',
    'utf8'
  );
}

/**
 * Builds a minimal, structurally valid x86-32 PE executable (`MZ` + `PE\0\0` + `.text` + `.rdata`)
 * with ImageBase 0x00400000, `.text` RVA 0x1000 (file offset 0x200), `.rdata` RVA 0x2000 (file offset 0x400).
 * This allows a reverser to parse standard PE headers, locate string xrefs in `.rdata`, and
 * disassemble the authentic x86-32 decode/dispatch routines in `.text`.
 */
function buildMinimalPeExe(textCode: Buffer, rdataBytes: Buffer): Buffer {
  const fileAlign = 0x200;
  const secAlign = 0x1000;
  const textRawSize = Math.max(fileAlign, Math.ceil(textCode.length / fileAlign) * fileAlign);
  const rdataRawSize = Math.max(fileAlign, Math.ceil(rdataBytes.length / fileAlign) * fileAlign);
  const totalSize = 0x200 + textRawSize + rdataRawSize;
  const buf = Buffer.alloc(totalSize);

  // DOS Header
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew = 0x80

  // PE Signature + COFF File Header (20 bytes)
  const pe = 0x80;
  buf.write('PE\0\0', pe, 'ascii');
  buf.writeUInt16LE(0x014c, pe + 4); // Machine: IMAGE_FILE_MACHINE_I386 (x86)
  buf.writeUInt16LE(2, pe + 6); // NumberOfSections: 2 (.text, .rdata)
  buf.writeUInt16LE(0xe0, pe + 20); // SizeOfOptionalHeader: 224 (PE32)
  buf.writeUInt16LE(0x0102, pe + 22); // Characteristics: EXECUTABLE_IMAGE | 32BIT_MACHINE

  // Optional Header (PE32)
  const opt = pe + 24;
  buf.writeUInt16LE(0x010b, opt); // Magic: PE32
  buf.writeUInt32LE(0x1000, opt + 16); // AddressOfEntryPoint
  buf.writeUInt32LE(0x1000, opt + 20); // BaseOfCode
  buf.writeUInt32LE(0x2000, opt + 24); // BaseOfData
  buf.writeUInt32LE(0x00400000, opt + 28); // ImageBase
  buf.writeUInt32LE(secAlign, opt + 32); // SectionAlignment
  buf.writeUInt32LE(fileAlign, opt + 36); // FileAlignment
  buf.writeUInt32LE(0x3000, opt + 56); // SizeOfImage
  buf.writeUInt32LE(0x200, opt + 60); // SizeOfHeaders
  buf.writeUInt16LE(2, opt + 68); // Subsystem: WINDOWS_GUI
  buf.writeUInt32LE(16, opt + 92); // NumberOfRvaAndSizes

  // Section Table (2 x 40 bytes starting at opt + 0xe0 = 0x178)
  const sec0 = opt + 0xe0;
  buf.write('.text\0\0\0', sec0, 'ascii');
  buf.writeUInt32LE(textCode.length, sec0 + 8); // VirtualSize
  buf.writeUInt32LE(0x1000, sec0 + 12); // VirtualAddress
  buf.writeUInt32LE(textRawSize, sec0 + 16); // SizeOfRawData
  buf.writeUInt32LE(0x200, sec0 + 20); // PointerToRawData
  buf.writeUInt32LE(0x60000020, sec0 + 36); // CODE | EXECUTE | READ

  const sec1 = sec0 + 40;
  buf.write('.rdata\0\0', sec1, 'ascii');
  buf.writeUInt32LE(rdataBytes.length, sec1 + 8);
  buf.writeUInt32LE(0x2000, sec1 + 12);
  buf.writeUInt32LE(rdataRawSize, sec1 + 16);
  buf.writeUInt32LE(0x200 + textRawSize, sec1 + 20);
  buf.writeUInt32LE(0x40000040, sec1 + 36); // INITIALIZED_DATA | READ

  textCode.copy(buf, 0x200);
  rdataBytes.copy(buf, 0x200 + textRawSize);
  return buf;
}

function packRdataStrings(strings: string[]): { buf: Buffer; vaByText: Map<string, number> } {
  const parts: Buffer[] = [];
  const vaByText = new Map<string, number>();
  let cursor = 0;
  for (const s of strings) {
    vaByText.set(s, 0x00402000 + cursor);
    const b = Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0])]);
    parts.push(b);
    cursor += b.length;
  }
  return { buf: Buffer.concat(parts), vaByText };
}

function pushVa(va: number): Buffer {
  return Buffer.concat([Buffer.from([0x68]), u32le(va)]);
}

/* ========================= Half-Width Katakana Encoder (for L3) ========================= */

const FW_TO_HW: Record<string, string> = {
  'ア': 'ｱ', 'イ': 'ｲ', 'ウ': 'ｳ', 'エ': 'ｴ', 'オ': 'ｵ',
  'カ': 'ｶ', 'キ': 'ｷ', 'ク': 'ｸ', 'ケ': 'ｹ', 'コ': 'ｺ',
  'サ': 'ｻ', 'シ': 'ｼ', 'ス': 'ｽ', 'セ': 'ｾ', 'ソ': 'ｿ',
  'タ': 'ﾀ', 'チ': 'ﾁ', 'ツ': 'ﾂ', 'テ': 'ﾃ', 'ト': 'ﾄ',
  'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ',
  'ハ': 'ﾊ', 'ヒ': 'ﾋ', 'フ': 'ﾌ', 'ヘ': 'ﾍ', 'ホ': 'ﾎ',
  'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ',
  'ヤ': 'ﾔ', 'ユ': 'ﾕ', 'ヨ': 'ﾖ',
  'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ',
  'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ',
  'ァ': 'ｧ', 'ィ': 'ｨ', 'ゥ': 'ｩ', 'ェ': 'ｪ', 'ォ': 'ｫ',
  'ャ': 'ｬ', 'ュ': 'ｭ', 'ョ': 'ｮ', 'ッ': 'ｯ', 'ー': 'ｰ',
  'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ', 'グ': 'ｸﾞ', 'ゲ': 'ｹﾞ', 'ゴ': 'ｺﾞ',
  'ザ': 'ｻﾞ', 'ジ': 'ｼﾞ', 'ズ': 'ｽﾞ', 'ゼ': 'ｾﾞ', 'ゾ': 'ｿﾞ',
  'ダ': 'ﾀﾞ', 'ヂ': 'ﾁﾞ', 'ヅ': 'ﾂﾞ', 'デ': 'ﾃﾞ', 'ド': 'ﾄﾞ',
  'バ': 'ﾊﾞ', 'ビ': 'ﾋﾞ', 'ブ': 'ﾌﾞ', 'ベ': 'ﾍﾞ', 'ボ': 'ﾎﾞ',
  'パ': 'ﾊﾟ', 'ピ': 'ﾋﾟ', 'プ': 'ﾌﾟ', 'ペ': 'ﾍﾟ', 'ポ': 'ﾎﾟ',
  'ヴ': 'ｳﾞ',
};

function compressToHalfwidthKatakana(text: string): string {
  let out = '';
  for (const ch of text) {
    out += FW_TO_HW[ch] ?? ch;
  }
  return out;
}

/* ========================= Shared Realistic VN Corpus ========================= */

function buildDialogueSet(prefixTag: string, count: number, extraStyle?: 'tags' | 'katakana' | 'ruby'): GroundTruthTextEntry[] {
  const basePairs: Array<[string, string]> = [
    ['朝の光が教室の窓から差し込み、黒板のチョークの粉が静かに舞っていた。', '清晨的阳光透过教室窗户洒了进来，黑板上的粉笔灰在空中静静飞舞。'],
    ['「おはよう、今日もずいぶん早いんだな。昨夜はよく眠れたか？」', '“早上好，你今天也来得真早啊。昨晚睡得好吗？”'],
    ['「うん、少し緊張していたけれど、街の時計台が鳴るのを聞いたら落ち着いたよ。」', '“嗯，本来还有点紧张，不过听到镇上钟楼的钟声后就平静下来了。”'],
    ['商店街の角にある古い喫茶店からは、いつものように焙煎した珈琲の香りが漂ってくる。', '商业街拐角那家老咖啡馆里，一如既往地飘出烘焙咖啡的香气。'],
    ['「ねえ、放課後に屋上で星図の続きを確認しようって約束、忘れてないよね？」', '“呐，我们约好放学后去天台继续核对星图的，你没忘吧？”'],
    ['「もちろんだ。図書室で借りた観測記録ノートも鞄に入れてある。」', '“当然没忘。从图书室借来的观测记录本也装在书包里了。”'],
    ['海沿いの坂道を下ると、潮風と一緒に遠くのフェリーの汽笛が聞こえてきた。', '顺着海边坡道往下走，远处渡轮的汽笛声伴着海风传了过来。'],
    ['「それにしても、今年の文化祭は例年以上に準備が慌ただしいな。」', '“话说回来，今年的学园祭筹备工作比往年还要手忙脚乱呢。”'],
    ['「実行委員のみんなが夜遅くまで劇の台本を直していたから、私たちも手伝わないと。」', '“执行委员会的大家昨晚一直在修改话剧剧本到深夜，我们也得去搭把手才行。”'],
    ['夕暮れ時の校庭では、吹奏楽部の練習する柔らかな旋律が風に乗って響いていた。', '黄昏时的操场上，管乐社练习的柔和旋律乘着晚风阵阵回响。'],
    ['「もし明日雨が降ったら、観測会は視聴覚室に切り替えるって先生が言ってたよ。」', '“老师说如果明天下雨，观测会就改到视听教室举行哦。”'],
    ['「なるほど、それなら機材の片付けも慌てずに済みそうだな。」', '“原来如此，那样的话收拾器材也不用太仓促了。”'],
    ['古い倉庫の棚の奥から、埃をかぶった真鍮製の懐中時計が見つかった。', '在旧仓库货架最深处，发现了一块落满灰尘的黄铜怀表。'],
    ['「文字盤の裏に小さな刻印がある……これ、十年前のお祭りの記念品じゃない？」', '“表盘背面有一行小小的刻字……这该不会是十年前祭典的纪念品吧？”'],
    ['「針はまだ動いている。誰かが最近まで大切に手入れをしていたのかもしれないな。」', '“指针居然还在走。说不定直到最近还有人在细心保养它呢。”'],
    ['夜の図書館は昼間とはまるで別の顔を見せ、ページをめくる音だけが静かに響く。', '夜晚的图书馆展现出与白天截然不同的面貌，唯有翻动书页的声音静静回荡。'],
    ['「この地図に記された赤い印、駅前の広場じゃなくて旧灯台を指しているみたい。」', '“这张地图上画的红色标记，指的似乎不是站前广场，而是那座旧灯塔。”'],
    ['「行ってみよう。懐中電灯と予備の電池ならここにある。」', '“走吧，去看看。手电筒和备用电池我这里都带着呢。”'],
    ['石畳の階段を登りきると、港町の灯りが宝石箱をひっくり返したように広がっていた。', '爬完石板阶梯，港口小镇的万家灯火宛如打翻的珠宝盒般铺展在眼前。'],
    ['「わあ……こんなに遠くまで見渡せる場所があったなんて知らなかったよ。」', '“哇……我都不知道镇上还有视野这么开阔的地方呢。”'],
    ['「昔から地元の人しか知らない展望台なんだ。風が気持ちいいだろう？」', '“这是很久以前只有当地人才知道的展望台。海风吹着很舒服吧？”'],
    ['白い封筒の中には、色褪せた写真と丁寧な万年筆の文字が添えられていた。', '白色信封里面，装着一张褪色的老照片和一段用钢笔工整写就的留言。'],
    ['「未来の誰かがこれを見つけたとき、この街がまだ笑顔であふれていますように。」', '“愿未来的某个人发现这封信时，这座小镇依然洋溢着欢声笑语。”'],
    ['「なんだか胸が温かくなるね。私たちも今の記録を残しておこうか。」', '“不知怎么的，心里暖洋洋的呢。我们也把此刻的回忆留下来吧。”'],
    ['翌日、空は雲ひとつない快晴になり、中庭には色とりどりの旗が揺れていた。', '次日天空万里无云，中庭里五彩斑斓的彩旗随风轻扬。'],
    ['「準備完了！　開場まであと十分しかないから、受付の配置を最終確認しよう。」', '“准备完毕！距离开场只剩十分钟了，我们最后再核对一遍接待处的安排吧。”'],
    ['「看板も照明もばっちりだ。お客さんが喜んでくれるといいな。」', '“招牌和灯光都没问题。希望来访的客人们都能玩得开心。”'],
    ['最初の来客が微笑みながらパンフレットを受け取った瞬間、全員の顔に安堵が広がった。', '当第一位客人微笑着接过宣传册的那一刻，大家脸上都露出了如释重负的笑容。'],
    ['「大成功だね！　ここまで頑張ってきて本当に良かった。」', '“大成功呢！大家一路努力到现在真是太好了。”'],
    ['「まだ一日目が終わったばかりだ。明日の本番に向けて、今夜はゆっくり休もう。」', '“这才刚结束第一天呢。为了明天的重头戏，今晚先好好休息吧。”'],
    ['帰り道、赤く染まった水平線を見つめながら、二人の影が長く伸びていった。', '回家的路上，凝望着被夕阳染红的海平线，两人的影子被拉得很长很长。'],
    ['「ねえ、来年もまた同じ場所で、この景色を一緒に見られるかな？」', '“呐，明年我们还能在同一个地方，一起欣赏这片风景吗？”'],
    ['「ああ、約束するよ。何度季節が巡っても、きっと忘れない。」', '“嗯，我答应你。无论季节轮回多少次，我都一定不会忘记。”'],
    ['鐘の音が遠くへ消えていく中、新しい物語のページが静かにめくられた。', '在渐行渐远的钟声之中，全新故事的篇章被悄然翻开。'],
    ['「それじゃあ、また明日。遅刻しないで来いよ！」', '“那就明天见啦。可别迟到了哦！”'],
    ['「ふふっ、そっちこそ寝坊しないでね。じゃあね！」', '“呵呵，你才不要睡懒觉呢。明天见！”'],
  ];

  const katakanaPairs: Array<[string, string]> = [
    ['アリスとリンはカフェテラスでアイスコーヒーを注文した。', '爱丽丝和凛在露天咖啡座点了两杯冰咖啡。'],
    ['「パソコンのモニターにエラーメッセージが表示されているよ！」', '“电脑显示器上弹出了错误提示信息哦！”'],
    ['ガラスケースのケーキとプリンがキラキラ輝いている。', '玻璃柜里的蛋糕和布丁正闪闪发光。'],
    ['「パーティーのドレスとリボン、カタログから選んでおいたの。」', '“派对用的礼服和丝带，我已经从图录里挑好了哦。”'],
    ['バス停のベンチでカレンダーとメモ帳を確認しながら待った。', '在公交站的长椅上边核对日历和备忘录边等待。'],
    ['「ラジオから流れてきたメロディー、懐かしいアルバムの曲だね。」', '“收音机里传来的旋律，是那张怀念专辑里的曲子呢。”'],
  ];

  const out: GroundTruthTextEntry[] = [];
  for (let i = 0; i < count; i++) {
    const pair =
      extraStyle === 'katakana' && i < katakanaPairs.length
        ? katakanaPairs[i]
        : basePairs[i % basePairs.length];
    let src = pair[0];
    let zh = pair[1];
    if (extraStyle === 'tags' && i % 5 === 0) {
      src = `<C#FF8800>%player%</C>、${src}\\n続けて確認しよう。`;
      zh = `<C#FF8800>%player%</C>，${zh}\\n我们继续深入核对这段格外详尽的本地化超长测试译文吧。`;
    } else if (extraStyle === 'tags' && i % 7 === 0) {
      src = `アリス・リーゼは微笑んだ。${src}`;
      zh = `爱丽丝・莉泽微笑着说道：${zh}`;
    } else if (extraStyle === 'ruby' && i % 4 === 0) {
      src = `<ruby base="星図" text="せいず"/>第%d章：${src}\\n次の記録へ進む。`;
      zh = `<ruby base="星図" text="せいず"/>第%d章：${zh}\\n随后立刻翻开下一段长度翻倍的中文记录进行验证。`;
    } else if (i % 6 === 0) {
      // Deliberately make several translations significantly longer (2x+) to stress variable-length writeback
      zh = `${zh}（这是一段特意加长以严格检验变长写回与指针重定位正确性的中文扩展补充译文［${prefixTag}#${i + 1}］。）`;
    } else if (i % 9 === 0) {
      // Deliberately shorter line to test shrinking as well
      zh = `简短译文${i + 1}。`;
    }
    out.push({ source: src, track: 'scenario', kind: 'say', zhTranslation: zh });
  }
  return out;
}

/* ========================= L1: Plain Archive + UTF-8 Script + JSON UI ========================= */

const L1_GROUND_TRUTH: GroundTruthTextEntry[] = [
  ...buildDialogueSet('L1', 32),
  { source: 'アリス', track: 'ui', kind: 'name', zhTranslation: '爱丽丝' },
  { source: 'ミナト', track: 'ui', kind: 'name', zhTranslation: '凑' },
  { source: 'ハルカ', track: 'ui', kind: 'name', zhTranslation: '遥' },
  { source: 'レン', track: 'ui', kind: 'name', zhTranslation: '莲' },
  { source: '図書室へ向かう', track: 'ui', kind: 'choice', zhTranslation: '前往图书室查看资料' },
  { source: '屋上で星図を見る', track: 'ui', kind: 'choice', zhTranslation: '去天台一起核对星图' },
  { source: '商店街に寄り道する', track: 'ui', kind: 'choice', zhTranslation: '顺路去商业街逛逛' },
  { source: 'はじめから', track: 'ui', kind: 'system', zhTranslation: '新的开始' },
  { source: 'つづきから', track: 'ui', kind: 'system', zhTranslation: '继续游戏' },
  { source: '環境設定', track: 'ui', kind: 'system', zhTranslation: '环境设置' },
  { source: 'ゲーム終了', track: 'ui', kind: 'system', zhTranslation: '退出游戏' },
  { source: 'セーブしました。', track: 'ui', kind: 'system', zhTranslation: '存档已完成。' },
  { source: 'ロードしますか？', track: 'ui', kind: 'system', zhTranslation: '确定要读取存档吗？' },
];

function packVp1Archive(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const tocEntries: Buffer[] = [];
  let tocLen = 8; // 'VP1\0' + u32 count
  for (const e of entries) {
    tocLen += 2 + Buffer.byteLength(e.name, 'utf8') + 8;
  }
  let dataOffset = tocLen;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    tocEntries.push(Buffer.concat([u16le(nameBuf.length), nameBuf, u32le(dataOffset), u32le(e.data.length)]));
    dataOffset += e.data.length;
  }
  return Buffer.concat([Buffer.from('VP1\0', 'ascii'), u32le(entries.length), ...tocEntries, ...entries.map((e) => e.data)]);
}

function unpackVp1Archive(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 8 || buf.subarray(0, 4).toString('ascii') !== 'VP1\0') {
    throw new Error('VP1 魔数错误');
  }
  const count = buf.readUInt32LE(4);
  let pos = 8;
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(pos);
    pos += 2;
    const name = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen;
    const off = buf.readUInt32LE(pos);
    const size = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (off + size > buf.length) throw new Error(`VP1 条目越界: ${name}`);
    out.set(name, Buffer.from(buf.subarray(off, off + size)));
  }
  return out;
}

const L1_TASK: BenchTaskSpec = {
  id: 'L1-plain-archive',
  difficulty: 'L1',
  tierName: 'Tier 1 / 入门',
  title: '未加密自定义封包 (VP1) + UTF-8 剧本与 JSON UI 分离',
  description: '基础封包头与 TOC 解析、UTF-8 剧本/JSON UI 精准提取（过滤注释/命令/资源路径）及完整回包闭环。',
  expectedPipeline: 'skill',
  expectedSourceEncoding: 'utf-8',
  hasCustomControlTags: false,
  gameRelDir: 'game',
  archiveRelPaths: ['game/data.vp1'],
  rasterAssetRelPaths: ['img/title_btn.png'],
  minScenarioRecall: 1.0,
  minUiRecall: 0.95,
  groundTruth: L1_GROUND_TRUTH,
  forbiddenExtractedSubstrings: [
    'internal comment',
    'school_day',
    'track_01',
    'img/title.png',
    'title_btn.png',
    'WAIT_500',
  ],
  buildTaskPrompt: (gameDir) =>
    `工作区存在未知视觉小说封包 \`${gameDir}/data.vp1\`（内置解包器不支持）。请逆向分析其封包格式与内部脚本/界面文本结构，在 \`.papercup/research/<engine>/\` 落盘 01-layout.md、02-hypotheses.md、03-text-mapping.json，编写 unpack.py、repack.py、extract.py 与 apply.py，并通过 vn_learn_skill 完成闭环验证与技能落盘。严禁修改原始封包。`,
  generateFixture: (workspaceDir) => {
    writePapercupToml(workspaceDir);
    const gameDir = path.join(workspaceDir, 'game');
    fs.mkdirSync(gameDir, { recursive: true });

    const says = L1_GROUND_TRUTH.filter((e) => e.kind === 'say');
    const names = L1_GROUND_TRUTH.filter((e) => e.kind === 'name');
    const choices = L1_GROUND_TRUTH.filter((e) => e.kind === 'choice');
    const sys = L1_GROUND_TRUTH.filter((e) => e.kind === 'system');

    const scriptLines: string[] = [
      '; internal comment: chapter 01 header',
      '@bg school_day',
      '@bgm track_01',
      '@wait WAIT_500',
    ];
    says.forEach((s, idx) => {
      if (idx % 8 === 0) {
        const nm = names[Math.floor(idx / 8) % names.length];
        scriptLines.push(`@name ${nm.source}`);
      }
      scriptLines.push(`say "${s.source}"`);
      if (idx === 10 || idx === 20 || idx === 30) {
        const ch = choices[Math.floor(idx / 10) - 1];
        if (ch) scriptLines.push(`#choice ${ch.source}`);
      }
    });
    scriptLines.push('; internal comment: end of script');

    const menuJson = JSON.stringify(
      {
        version: 1,
        asset_bg: 'img/title.png',
        labels: {
          start: sys[0].source,
          load: sys[1].source,
          config: sys[2].source,
          quit: sys[3].source,
          save_ok: sys[4].source,
          load_confirm: sys[5].source,
        },
      },
      null,
      2
    );

    const archive = packVp1Archive([
      { name: 'script/ch01.vsc', data: Buffer.from(scriptLines.join('\n') + '\n', 'utf8') },
      { name: 'ui/menu.json', data: Buffer.from(menuJson + '\n', 'utf8') },
      { name: 'img/title_btn.png', data: MINIMAL_PNG },
    ]);
    fs.writeFileSync(path.join(gameDir, 'data.vp1'), archive);
  },
  verifyConsumer: ({ patchedGameDir, expectedBySource }): ConsumerVerificationResult => {
    const errors: string[] = [];
    let checked = 0;
    try {
      const files = unpackVp1Archive(fs.readFileSync(path.join(patchedGameDir, 'data.vp1')));
      const png = files.get('img/title_btn.png');
      if (!png || !png.equals(MINIMAL_PNG)) {
        errors.push('img/title_btn.png 字节损坏或丢失');
      }
      const scriptText = files.get('script/ch01.vsc')?.toString('utf8') ?? '';
      if (!scriptText.includes('@bg school_day') || !scriptText.includes('@bgm track_01')) {
        errors.push('script/ch01.vsc 中引擎指令 @bg/@bgm 被破坏');
      }
      const actualScriptLines = new Set<string>();
      for (const raw of scriptText.split(/\r?\n/)) {
        const t = raw.trim();
        const mSay = /^say\s+"(.*)"$/.exec(t);
        if (mSay) actualScriptLines.add(mSay[1]);
        const mName = /^@name\s+(.+)$/.exec(t);
        if (mName) actualScriptLines.add(mName[1].trim());
        const mChoice = /^#choice\s+(.+)$/.exec(t);
        if (mChoice) actualScriptLines.add(mChoice[1].trim());
      }
      const menuObj = JSON.parse(files.get('ui/menu.json')?.toString('utf8') ?? '{}');
      if (menuObj.asset_bg !== 'img/title.png') {
        errors.push(`ui/menu.json 的 asset_bg 被意外修改: ${menuObj.asset_bg}`);
      }
      const actualUiValues = new Set<string>(Object.values(menuObj.labels || {}).map(String));

      for (const gt of L1_GROUND_TRUTH) {
        const expected = expectedBySource.get(gt.source) ?? gt.source;
        const pool = gt.kind === 'system' ? actualUiValues : actualScriptLines;
        if (!pool.has(expected)) {
          errors.push(`未在回包后的游戏文件中找到期望文本: ${expected.slice(0, 50)}`);
        } else {
          checked += 1;
        }
      }
    } catch (err: any) {
      errors.push(`VP1 消费端解析异常: ${err?.message || String(err)}`);
    }
    return { ok: errors.length === 0, checkedCount: checked, errors };
  },
};

/* ========================= L2: XOR Archive + CP932 + Control Tags + GBK ========================= */

const L2_GROUND_TRUTH: GroundTruthTextEntry[] = [
  ...buildDialogueSet('L2', 32, 'tags'),
  { source: 'カレン', track: 'ui', kind: 'name', zhTranslation: '卡莲' },
  { source: 'ソウタ', track: 'ui', kind: 'name', zhTranslation: '苍太' },
  { source: 'ユイ', track: 'ui', kind: 'name', zhTranslation: '由衣' },
  { source: 'マコト', track: 'ui', kind: 'name', zhTranslation: '真琴' },
  { source: '右の道へ進む', track: 'ui', kind: 'choice', zhTranslation: '沿着右侧小路继续前行' },
  { source: '左の路地を調べる', track: 'ui', kind: 'choice', zhTranslation: '调查左侧幽静的小巷' },
  { source: 'クイックセーブ', track: 'ui', kind: 'system', zhTranslation: '快速存档' },
  { source: 'クイックロード', track: 'ui', kind: 'system', zhTranslation: '快速读档' },
  { source: 'オート再生', track: 'ui', kind: 'system', zhTranslation: '自动播放' },
  { source: 'スキップ切替', track: 'ui', kind: 'system', zhTranslation: '切换快进' },
  { source: 'ログ表示', track: 'ui', kind: 'system', zhTranslation: '查看履历' },
  { source: 'タイトルへ戻る', track: 'ui', kind: 'system', zhTranslation: '返回标题画面' },
];

const L2_XOR_SEED = 0x5a;

function xorXpkStream(buf: Buffer, seed: number): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ ((seed + i * 17) & 0xff);
  }
  return out;
}

function packXpk2Archive(entries: Array<{ name: string; data: Buffer }>, seed = L2_XOR_SEED): Buffer {
  const tocParts: Buffer[] = [];
  let relOff = 0;
  for (const e of entries) {
    const nb = Buffer.from(e.name, 'ascii');
    tocParts.push(Buffer.concat([u16le(nb.length), nb, u32le(relOff), u32le(e.data.length)]));
    relOff += e.data.length;
  }
  const plainToc = Buffer.concat(tocParts);
  const encToc = xorXpkStream(plainToc, seed);
  const plainBody = Buffer.concat(entries.map((e) => e.data));
  const encBody = xorXpkStream(plainBody, (seed + 1) & 0xff);
  return Buffer.concat([
    Buffer.from('XPK2', 'ascii'),
    u32le(seed),
    u32le(entries.length),
    u32le(plainToc.length),
    encToc,
    encBody,
  ]);
}

function unpackXpk2Archive(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 16 || buf.subarray(0, 4).toString('ascii') !== 'XPK2') {
    throw new Error('XPK2 魔数错误');
  }
  const seed = buf.readUInt32LE(4);
  const count = buf.readUInt32LE(8);
  const tocLen = buf.readUInt32LE(12);
  const plainToc = xorXpkStream(buf.subarray(16, 16 + tocLen), seed);
  const plainBody = xorXpkStream(buf.subarray(16 + tocLen), (seed + 1) & 0xff);
  const out = new Map<string, Buffer>();
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const nlen = plainToc.readUInt16LE(pos);
    pos += 2;
    const name = plainToc.subarray(pos, pos + nlen).toString('ascii');
    pos += nlen;
    const off = plainToc.readUInt32LE(pos);
    const size = plainToc.readUInt32LE(pos + 4);
    pos += 8;
    if (off + size > plainBody.length) throw new Error(`XPK2 条目越界: ${name}`);
    out.set(name, Buffer.from(plainBody.subarray(off, off + size)));
  }
  return out;
}

const L2_TASK: BenchTaskSpec = {
  id: 'L2-cp932-xor-archive',
  difficulty: 'L2',
  tierName: 'Tier 2 / 简单',
  title: 'XOR 加密封包 (XPK2) + CP932/GBK 转码 + 自定义控制标签',
  description: '需解开双段流式 XOR 封包，识别 CP932 编码，向 engine.json 注册自定义 <C#...> 控制符，并支持 PAPERCUP_TARGET_ENCODING=gbk 变长中文写回。',
  expectedPipeline: 'skill',
  expectedSourceEncoding: 'cp932',
  hasCustomControlTags: true,
  gameRelDir: 'game',
  archiveRelPaths: ['game/story.xpk'],
  minScenarioRecall: 1.0,
  minUiRecall: 0.95,
  groundTruth: L2_GROUND_TRUTH,
  forbiddenExtractedSubstrings: ['bg_01.png', 'click.ogg', 'KEY_BG', 'KEY_SE', '#CMD_FADE', 'internal_note'],
  buildTaskPrompt: (gameDir) =>
    `工作区存在未知封包 \`${gameDir}/story.xpk\`（同目录含 \`xpk_player.exe\`）。目标为日文转简体中文，请逆向分析封包加密、文本编码与内联控制标签，落盘研究文档与 unpack.py / repack.py / extract.py / apply.py（支持 PAPERCUP_TARGET_ENCODING=gbk/cp932/utf-8），并通过 vn_learn_skill 注册技能与 controlPattern。严禁修改原始文件。`,
  generateFixture: (workspaceDir) => {
    writePapercupToml(workspaceDir);
    const gameDir = path.join(workspaceDir, 'game');
    fs.mkdirSync(gameDir, { recursive: true });

    const says = L2_GROUND_TRUTH.filter((e) => e.kind === 'say');
    const names = L2_GROUND_TRUTH.filter((e) => e.kind === 'name');
    const choices = L2_GROUND_TRUTH.filter((e) => e.kind === 'choice');
    const sys = L2_GROUND_TRUTH.filter((e) => e.kind === 'system');

    const epLines: string[] = ['// internal_note: episode 01', '#CMD_FADE IN 300'];
    says.forEach((s, idx) => {
      if (idx % 8 === 0) epLines.push(`[NAME] ${names[Math.floor(idx / 8) % names.length].source}`);
      epLines.push(`[SAY] ${s.source}`);
      if (idx === 12) epLines.push(`[CHOICE] ${choices[0].source}`);
      if (idx === 24) epLines.push(`[CHOICE] ${choices[1].source}`);
    });
    const sysLines = [
      'KEY_BG=bg_01.png',
      'KEY_SE=click.ogg',
      ...sys.map((s, i) => `LABEL_${i}=${s.source}`),
    ];

    const archive = packXpk2Archive([
      { name: 'story/ep01.s', data: encodeText(epLines.join('\r\n') + '\r\n', 'cp932') },
      { name: 'sys/labels.txt', data: encodeText(sysLines.join('\r\n') + '\r\n', 'cp932') },
    ]);
    fs.writeFileSync(path.join(gameDir, 'story.xpk'), archive);

    // Authentic minimal x86-32 PE exe containing XPK2 XOR stride (17 = 0x11) and +1 body seed
    const { buf: rdata, vaByText } = packRdataStrings(['XPK2', 'story.xpk', 'story/ep01.s', 'sys/labels.txt']);
    // push va("XPK2"); xor ecx, ecx; cmp ecx, edx; jae +15; imul eax, ecx, 0x11; add eax, ebx; xor byte ptr [esi+ecx], al; inc ecx; jmp -17; ret
    const textCode = Buffer.concat([
      pushVa(vaByText.get('XPK2')!),
      Buffer.from([
        0x31, 0xc9,                   // xor ecx, ecx
        0x39, 0xd1,                   // cmp ecx, edx
        0x73, 0x0d,                   // jae +13 -> ret
        0x6b, 0xc1, 0x11,             // imul eax, ecx, 17 (0x11)
        0x01, 0xd8,                   // add eax, ebx (seed)
        0x30, 0x04, 0x0e,             // xor [esi+ecx], al
        0x41,                         // inc ecx
        0xeb, 0xf1,                   // jmp -15
        0xc3,                         // ret
        // body seed = seed + 1
        0x8d, 0x5b, 0x01,             // lea ebx, [ebx+1]
        0xc3,                         // ret
      ]),
    ]);
    fs.writeFileSync(path.join(gameDir, 'xpk_player.exe'), buildMinimalPeExe(textCode, rdata));
  },
  verifyConsumer: ({ patchedGameDir, appliedEncoding, expectedBySource }): ConsumerVerificationResult => {
    const errors: string[] = [];
    let checked = 0;
    try {
      const files = unpackXpk2Archive(fs.readFileSync(path.join(patchedGameDir, 'story.xpk')));
      const epRaw = files.get('story/ep01.s');
      const sysRaw = files.get('sys/labels.txt');
      if (!epRaw || !sysRaw) {
        return { ok: false, checkedCount: 0, errors: ['回包缺少 story/ep01.s 或 sys/labels.txt'] };
      }
      const epText = decodeStrict(epRaw, appliedEncoding);
      const sysText = decodeStrict(sysRaw, appliedEncoding);
      if (!epText.includes('#CMD_FADE IN 300') || !sysText.includes('KEY_BG=bg_01.png')) {
        errors.push('原始指令或内部资源键被破坏');
      }
      const epValues = new Set<string>();
      for (const line of epText.split(/\r?\n/)) {
        const m = /^\[(SAY|NAME|CHOICE)\]\s+(.+)$/.exec(line.trim());
        if (m) epValues.add(m[2]);
      }
      const sysValues = new Set<string>();
      for (const line of sysText.split(/\r?\n/)) {
        const m = /^LABEL_\d+=(.+)$/.exec(line.trim());
        if (m) sysValues.add(m[1]);
      }
      for (const gt of L2_GROUND_TRUTH) {
        const rawExp = expectedBySource.get(gt.source) ?? gt.source;
        const expected = normalizeExpectedForEncoding(rawExp, appliedEncoding);
        const pool = gt.kind === 'system' ? sysValues : epValues;
        if (!pool.has(expected)) {
          errors.push(`编码 ${appliedEncoding} 解码后未找到期望文本: ${expected.slice(0, 50)}`);
        } else {
          checked += 1;
        }
      }
    } catch (err: any) {
      errors.push(`XPK2 消费端解码/解析失败 (${appliedEncoding}): ${err?.message || String(err)}`);
    }
    return { ok: errors.length === 0, checkedCount: checked, errors };
  },
};

/* ========================= L3: Zlib Single-File Binary + Half-Width Katakana Compression ========================= */

const L3_GROUND_TRUTH: GroundTruthTextEntry[] = [
  ...buildDialogueSet('L3', 32, 'katakana'),
  { source: 'アリス', track: 'ui', kind: 'name', zhTranslation: '爱丽丝' },
  { source: 'リン', track: 'ui', kind: 'name', zhTranslation: '凛' },
  { source: 'マスター', track: 'ui', kind: 'name', zhTranslation: '店长' },
  { source: 'セバスチャン', track: 'ui', kind: 'name', zhTranslation: '塞巴斯蒂安' },
  { source: 'カフェテラスに座る', track: 'ui', kind: 'choice', zhTranslation: '在露天咖啡座坐下' },
  { source: 'カウンター席を選ぶ', track: 'ui', kind: 'choice', zhTranslation: '选择吧台座位' },
  { source: 'メニューを確認する', track: 'ui', kind: 'choice', zhTranslation: '查看今日菜单' },
  { source: 'システムメニュー', track: 'ui', kind: 'system', zhTranslation: '系统菜单' },
  { source: 'セーブデータ一覧', track: 'ui', kind: 'system', zhTranslation: '存档列表' },
  { source: 'コンフィグ設定', track: 'ui', kind: 'system', zhTranslation: '参数配置' },
  { source: 'メッセージ速度', track: 'ui', kind: 'system', zhTranslation: '文字显示速度' },
  { source: 'ボイス音量', track: 'ui', kind: 'system', zhTranslation: '语音音量' },
  { source: 'バックログを閉じる', track: 'ui', kind: 'system', zhTranslation: '关闭对话履历' },
];

const L3_INTERNAL_KEYS = [
  'btn_save_01',
  'btn_load_02',
  'UI_PANEL_設定',
  'UI_PANEL_音量',
  'CG_EVENT_03',
  'BGM_CAFE_LOOP',
  'SE_BUTTON_OK',
  'FLAG_ROUTE_MAIN',
  'TEX_TITLE_LOGO',
  'SCRIPT_ENTRY_00',
];

function buildBscrFile(): Buffer {
  const recBuffers: Buffer[] = [];
  let recId = 100;
  const pushRec = (kindCode: number, text: string, compressKana: boolean) => {
    const stored = compressKana ? compressToHalfwidthKatakana(text) : text;
    const bytes = encodeText(stored, 'cp932');
    recBuffers.push(Buffer.concat([u32le(recId++), Buffer.from([kindCode]), u16le(bytes.length), bytes]));
  };

  for (const key of L3_INTERNAL_KEYS.slice(0, 5)) pushRec(9, key, false);
  for (const gt of L3_GROUND_TRUTH) {
    const code = gt.kind === 'say' ? 1 : gt.kind === 'name' ? 2 : gt.kind === 'choice' ? 3 : 4;
    pushRec(code, gt.source, true);
  }
  for (const key of L3_INTERNAL_KEYS.slice(5)) pushRec(9, key, false);

  const plain = Buffer.concat([u32le(recBuffers.length), ...recBuffers]);
  const comp = zlib.deflateSync(plain);
  return Buffer.concat([Buffer.from('BSCR', 'ascii'), u32le(1), u32le(plain.length), u32le(comp.length), comp]);
}

function parseBscrFile(buf: Buffer): Array<{ recId: number; kindCode: number; raw: Buffer }> {
  if (buf.length < 16 || buf.subarray(0, 4).toString('ascii') !== 'BSCR') {
    throw new Error('BSCR 魔数错误');
  }
  const uncompLen = buf.readUInt32LE(8);
  const compLen = buf.readUInt32LE(12);
  if (16 + compLen > buf.length) throw new Error('BSCR 压缩段截断');
  const plain = zlib.inflateSync(buf.subarray(16, 16 + compLen));
  if (plain.length !== uncompLen) {
    throw new Error(`BSCR 解压长度不匹配: header=${uncompLen}, actual=${plain.length}`);
  }
  const count = plain.readUInt32LE(0);
  let pos = 4;
  const out: Array<{ recId: number; kindCode: number; raw: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    const recId = plain.readUInt32LE(pos);
    const kindCode = plain[pos + 4];
    const blen = plain.readUInt16LE(pos + 5);
    pos += 7;
    if (pos + blen > plain.length) throw new Error(`BSCR 记录越界: recId=${recId}`);
    out.push({ recId, kindCode, raw: Buffer.from(plain.subarray(pos, pos + blen)) });
    pos += blen;
  }
  if (pos !== plain.length) throw new Error(`BSCR 尾部存在未解析字节: pos=${pos}, len=${plain.length}`);
  return out;
}

const L3_TASK: BenchTaskSpec = {
  id: 'L3-halfwidth-kana-direct',
  difficulty: 'L3',
  tierName: 'Tier 3 / 中等',
  title: '单文件 zlib 二进制剧本 (BSCR) + 半角片假名压缩 + 内部键过滤',
  description: '无外层封包（pipeline=direct）；需识别 CP932 半角片假名压缩并在 extract.py 还原为标准全角日文，彻底过滤 kind_code=9 内部键，并支持变长 GBK/UTF-8 重建。',
  expectedPipeline: 'direct',
  expectedSourceEncoding: 'cp932',
  hasCustomControlTags: false,
  gameRelDir: 'game',
  minScenarioRecall: 1.0,
  minUiRecall: 0.95,
  groundTruth: L3_GROUND_TRUTH,
  forbiddenExtractedSubstrings: [...L3_INTERNAL_KEYS, 'ｱ', 'ｶﾞ', 'ﾊﾟ'],
  buildTaskPrompt: (gameDir) =>
    `工作区 \`${gameDir}/scenario.bscr\` 是单文件编译剧本（无外层可拆封包）。请逆向分析其结构与编码压缩方式，落盘研究记录并编写直抽/直写脚本 extract.py 与 apply.py（pipeline="direct"，支持 PAPERCUP_TARGET_ENCODING=gbk/cp932/utf-8），过滤内部查找键，最后通过 vn_learn_skill 完成闭环验证。严禁修改原始文件。`,
  generateFixture: (workspaceDir) => {
    writePapercupToml(workspaceDir);
    const gameDir = path.join(workspaceDir, 'game');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'scenario.bscr'), buildBscrFile());
  },
  verifyConsumer: ({ patchedGameDir, appliedEncoding, expectedBySource, mode }): ConsumerVerificationResult => {
    const errors: string[] = [];
    let checked = 0;
    try {
      const records = parseBscrFile(fs.readFileSync(path.join(patchedGameDir, 'scenario.bscr')));
      const internalRecords = records.filter((r) => r.kindCode === 9);
      if (internalRecords.length !== L3_INTERNAL_KEYS.length) {
        errors.push(`内部键记录数变化: 期望 ${L3_INTERNAL_KEYS.length}, 实际 ${internalRecords.length}`);
      } else {
        for (let i = 0; i < L3_INTERNAL_KEYS.length; i++) {
          const expectedRaw = encodeText(L3_INTERNAL_KEYS[i], 'cp932');
          if (!internalRecords[i].raw.equals(expectedRaw)) {
            errors.push(`内部键被意外修改: ${L3_INTERNAL_KEYS[i]}`);
          }
        }
      }
      const playerRecords = records.filter((r) => r.kindCode !== 9);
      if (playerRecords.length !== L3_GROUND_TRUTH.length) {
        errors.push(`玩家文本记录数异常: 期望 ${L3_GROUND_TRUTH.length}, 实际 ${playerRecords.length}`);
      } else {
        for (let i = 0; i < L3_GROUND_TRUTH.length; i++) {
          const gt = L3_GROUND_TRUTH[i];
          const decoded = decodeStrict(playerRecords[i].raw, appliedEncoding);
          const rawExp = expectedBySource.get(gt.source) ?? gt.source;
          const expected =
            mode === 'identity'
              ? compressToHalfwidthKatakana(rawExp)
              : normalizeExpectedForEncoding(rawExp, appliedEncoding);
          if (decoded !== expected && (mode !== 'identity' || decoded !== rawExp)) {
            errors.push(`记录 #${i} 内容不匹配: 期望 "${expected.slice(0, 40)}", 实际 "${decoded.slice(0, 40)}"`);
          } else {
            checked += 1;
          }
        }
      }
    } catch (err: any) {
      errors.push(`BSCR 消费端解析失败: ${err?.message || String(err)}`);
    }
    return { ok: errors.length === 0, checkedCount: checked, errors };
  },
};

/* ========================= L4: Decoy Plaintext STR0 + Obfuscated MSG1 + Real PE x86 Decoder ========================= */

const L4_MSG1_SAYS = buildDialogueSet('L4', 36);
const L4_MSG1_NAMES: GroundTruthTextEntry[] = [
  { source: 'ノア', track: 'ui', kind: 'name', zhTranslation: '诺亚' },
  { source: 'セツナ', track: 'ui', kind: 'name', zhTranslation: '刹那' },
  { source: 'クロエ', track: 'ui', kind: 'name', zhTranslation: '克洛伊' },
  { source: 'ユウト', track: 'ui', kind: 'name', zhTranslation: '悠斗' },
];
const L4_STR0_REAL_UI: GroundTruthTextEntry[] = [
  { source: 'セーブしますか？', track: 'ui', kind: 'system', zhTranslation: '是否保存当前进度？' },
  { source: 'ロードしますか？', track: 'ui', kind: 'system', zhTranslation: '是否读取该存档？' },
  { source: '環境設定を保存しました。', track: 'ui', kind: 'system', zhTranslation: '已保存环境设置。' },
  { source: 'ゲームを終了しますか？', track: 'ui', kind: 'system', zhTranslation: '确定要退出游戏吗？' },
];
const L4_GROUND_TRUTH: GroundTruthTextEntry[] = [...L4_MSG1_SAYS, ...L4_MSG1_NAMES, ...L4_STR0_REAL_UI];

const L4_STR0_DECOYS: string[] = [
  '(nonnull) ui . GetPanel ( "ビューポート" )',
  '(nonnull) ui . GetButton ( "セーブ実行" )',
  '(nonnull) ui . GetSpinBox ( "音量スライダー" )',
  '(nonnull) ui . GetCheckBox ( "フルスクリーン" )',
  'CWidget::SetPos：無効な座標が指定されました',
  'CSceneLoader::Open：リソース読み込みエラー',
  'ERROR_LOAD_FAIL_0x01',
  'DEBUG_TRACE_HOOK',
  'Asset/UI/MainMenu/bg_panel.png',
  'Asset/Voice/ch01_001.ogg',
  ...Array.from({ length: 40 }, (_, i) => `(nonnull) activity . GetForm ( "エディタパネル_${i + 1}" )`),
];

function encryptL4Msg1(plain: Buffer): Buffer {
  const out = Buffer.alloc(plain.length);
  for (let j = 0; j < plain.length; j++) {
    out[j] = ((plain[j] + 0x47 + j) & 0xff) ^ 0xa5;
  }
  return out;
}

function decryptL4Msg1(enc: Buffer): Buffer {
  const out = Buffer.alloc(enc.length);
  for (let j = 0; j < enc.length; j++) {
    out[j] = ((enc[j] ^ 0xa5) - 0x47 - j) & 0xff;
  }
  return out;
}

function buildL4Cbin(): Buffer {
  // STR0: decoys + 4 genuine UI prompts (plaintext NUL-terminated CP932)
  const str0Strings = [...L4_STR0_DECOYS, ...L4_STR0_REAL_UI.map((e) => e.source)];
  const str0Body = Buffer.concat([
    u32le(str0Strings.length),
    ...str0Strings.map((s) => Buffer.concat([encodeText(s, 'cp932'), Buffer.from([0])])),
  ]);

  // MSG1: 40 obfuscated records (36 say + 4 name)
  const msg1Entries = [...L4_MSG1_NAMES, ...L4_MSG1_SAYS];
  const msg1Body = Buffer.concat([
    u32le(msg1Entries.length),
    ...msg1Entries.map((e) => {
      const enc = encryptL4Msg1(encodeText(e.source, 'cp932'));
      return Buffer.concat([u32le(enc.length), enc]);
    }),
  ]);

  const plain = Buffer.concat([
    Buffer.from('STR0', 'ascii'),
    u32le(str0Body.length),
    str0Body,
    Buffer.from('MSG1', 'ascii'),
    u32le(msg1Body.length),
    msg1Body,
    Buffer.from('TAIL', 'ascii'),
    u32le(0x11223344),
  ]);
  const comp = zlib.deflateSync(plain);
  return Buffer.concat([Buffer.from('CBIN', 'ascii'), u32le(plain.length), u32le(comp.length), comp]);
}

function parseL4Cbin(buf: Buffer): { str0: Buffer[]; msg1: Buffer[]; tailMagic: number } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'CBIN') {
    throw new Error('CBIN 魔数错误');
  }
  const uncompLen = buf.readUInt32LE(4);
  const compLen = buf.readUInt32LE(8);
  const plain = zlib.inflateSync(buf.subarray(12, 12 + compLen));
  if (plain.length !== uncompLen) throw new Error(`CBIN 解压长度不一致: ${plain.length} != ${uncompLen}`);

  let pos = 0;
  if (plain.subarray(pos, pos + 4).toString('ascii') !== 'STR0') throw new Error('缺少 STR0 区段');
  const str0Len = plain.readUInt32LE(pos + 4);
  pos += 8;
  const str0End = pos + str0Len;
  const str0Count = plain.readUInt32LE(pos);
  let sp = pos + 4;
  const str0: Buffer[] = [];
  for (let i = 0; i < str0Count; i++) {
    const nul = plain.indexOf(0, sp);
    if (nul < 0 || nul >= str0End) throw new Error(`STR0 槽位 ${i} 缺少 NUL 终止`);
    str0.push(Buffer.from(plain.subarray(sp, nul)));
    sp = nul + 1;
  }
  pos = str0End;

  if (plain.subarray(pos, pos + 4).toString('ascii') !== 'MSG1') throw new Error('缺少 MSG1 区段');
  const msg1Len = plain.readUInt32LE(pos + 4);
  pos += 8;
  const msg1End = pos + msg1Len;
  const msg1Count = plain.readUInt32LE(pos);
  let mp = pos + 4;
  const msg1: Buffer[] = [];
  for (let i = 0; i < msg1Count; i++) {
    const len = plain.readUInt32LE(mp);
    mp += 4;
    if (mp + len > msg1End) throw new Error(`MSG1 记录 ${i} 越界`);
    msg1.push(decryptL4Msg1(plain.subarray(mp, mp + len)));
    mp += len;
  }
  pos = msg1End;
  if (plain.subarray(pos, pos + 4).toString('ascii') !== 'TAIL') throw new Error('TAIL 尾部标记损坏');
  const tailMagic = plain.readUInt32LE(pos + 4);
  return { str0, msg1, tailMagic };
}

const L4_TASK: BenchTaskSpec = {
  id: 'L4-obfuscated-msg-trap',
  difficulty: 'L4',
  tierName: 'Tier 4 / 困难',
  title: '明文诱饵 STR0 + 字节混淆剧情区段 MSG1 + PE 可执行解码逆向',
  description: '还原真实痛点：STR0 充满明文编辑器控件查找键，真正的 40 条剧情/角色名在字节混淆的 MSG1 区段；必须反汇编 trial.exe 找到 MSG1 解码循环，严禁只抽 STR0 交差。',
  expectedPipeline: 'direct',
  expectedSourceEncoding: 'cp932',
  hasCustomControlTags: false,
  gameRelDir: 'game',
  minScenarioRecall: 1.0,
  minUiRecall: 0.75,
  groundTruth: L4_GROUND_TRUTH,
  forbiddenExtractedSubstrings: [
    '(nonnull)',
    'GetPanel',
    'GetButton',
    'GetSpinBox',
    'GetCheckBox',
    'GetForm',
    'CWidget::SetPos',
    'CSceneLoader::Open',
    'ERROR_LOAD_FAIL',
    'Asset/UI/',
  ],
  buildTaskPrompt: (gameDir) =>
    `工作区 \`${gameDir}/\` 包含编译剧本 \`trial.cbin\` 与主程序 \`trial.exe\`（无外层封包）。请完整定位并抽取可译剧情与界面文本（切勿遗漏加密/混淆区段，也不要把引擎控件查找键当可译文本），落盘研究记录与直抽/直写脚本 extract.py / apply.py（pipeline="direct"，支持 PAPERCUP_TARGET_ENCODING=gbk/cp932/utf-8），并通过 vn_learn_skill 闭环验证。严禁修改原始文件。`,
  generateFixture: (workspaceDir) => {
    writePapercupToml(workspaceDir);
    const gameDir = path.join(workspaceDir, 'game');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'trial.cbin'), buildL4Cbin());

    const { buf: rdata, vaByText } = packRdataStrings(['trial.cbin', 'STR0', 'MSG1', 'TAIL']);
    // Authentic x86-32 decoder right after `push va("MSG1")`:
    //   xor ecx, ecx
    // loop:
    //   cmp ecx, edx
    //   jae done (+16)
    //   movzx eax, byte ptr [esi+ecx]
    //   xor al, 0xA5
    //   sub al, 0x47
    //   sub al, cl
    //   mov byte ptr [edi+ecx], al
    //   inc ecx
    //   jmp loop (-20)
    // done:
    //   ret
    const textCode = Buffer.concat([
      pushVa(vaByText.get('trial.cbin')!),
      pushVa(vaByText.get('STR0')!),
      pushVa(vaByText.get('MSG1')!),
      Buffer.from([
        0x31, 0xc9,                   // xor ecx, ecx
        0x39, 0xd1,                   // cmp ecx, edx
        0x73, 0x10,                   // jae +16
        0x0f, 0xb6, 0x04, 0x0e,       // movzx eax, byte ptr [esi+ecx]
        0x34, 0xa5,                   // xor al, 0xA5
        0x2c, 0x47,                   // sub al, 0x47
        0x28, 0xc8,                   // sub al, cl
        0x88, 0x04, 0x0f,             // mov byte ptr [edi+ecx], al
        0x41,                         // inc ecx
        0xeb, 0xec,                   // jmp -20
        0xc3,                         // ret
      ]),
    ]);
    fs.writeFileSync(path.join(gameDir, 'trial.exe'), buildMinimalPeExe(textCode, rdata));
  },
  verifyConsumer: ({ patchedGameDir, appliedEncoding, expectedBySource }): ConsumerVerificationResult => {
    const errors: string[] = [];
    let checked = 0;
    try {
      const parsed = parseL4Cbin(fs.readFileSync(path.join(patchedGameDir, 'trial.cbin')));
      if (parsed.tailMagic !== 0x11223344) {
        errors.push(`TAIL 校验魔数损坏: 0x${parsed.tailMagic.toString(16)}`);
      }
      // Verify all decoy lookup keys in STR0 remained byte-identical
      for (let i = 0; i < L4_STR0_DECOYS.length; i++) {
        const origRaw = encodeText(L4_STR0_DECOYS[i], 'cp932');
        if (!parsed.str0[i] || !parsed.str0[i].equals(origRaw)) {
          errors.push(`STR0 控件查找键槽位 #${i} 被破坏`);
          break;
        }
      }
      // Verify all 40 MSG1 records decrypted cleanly and match expected translations
      const msg1Entries = [...L4_MSG1_NAMES, ...L4_MSG1_SAYS];
      if (parsed.msg1.length !== msg1Entries.length) {
        errors.push(`MSG1 记录数变化: 期望 ${msg1Entries.length}, 实际 ${parsed.msg1.length}`);
      } else {
        for (let i = 0; i < msg1Entries.length; i++) {
          const gt = msg1Entries[i];
          const decoded = decodeStrict(parsed.msg1[i], appliedEncoding);
          const expected = normalizeExpectedForEncoding(expectedBySource.get(gt.source) ?? gt.source, appliedEncoding);
          if (decoded !== expected) {
            errors.push(`MSG1[#${i}] 不匹配: 期望 "${expected.slice(0, 40)}", 实际 "${decoded.slice(0, 40)}"`);
          } else {
            checked += 1;
          }
        }
      }
    } catch (err: any) {
      errors.push(`CBIN 消费端解析失败: ${err?.message || String(err)}`);
    }
    return { ok: errors.length === 0, checkedCount: checked, errors };
  },
};

/* ========================= L5: Consumer Byte-Offset Pointer Relocation VM ========================= */

const L5_SAYS = buildDialogueSet('L5', 34);
const L5_NAMES: GroundTruthTextEntry[] = [
  { source: 'カナデ', track: 'ui', kind: 'name', zhTranslation: '奏' },
  { source: 'タクミ', track: 'ui', kind: 'name', zhTranslation: '拓海' },
  { source: 'ミサキ', track: 'ui', kind: 'name', zhTranslation: '美咲' },
  { source: 'シオン', track: 'ui', kind: 'name', zhTranslation: '诗音' },
];
const L5_CHOICES: GroundTruthTextEntry[] = [
  { source: '旧校舎を探索する', track: 'ui', kind: 'choice', zhTranslation: '深入探索旧校舍的走廊' },
  { source: '中庭で合流を待つ', track: 'ui', kind: 'choice', zhTranslation: '留在中庭等待同伴汇合' },
  { source: '保健室へ顔を出す', track: 'ui', kind: 'choice', zhTranslation: '去保健室打个招呼' },
  { source: 'そのまま帰路につく', track: 'ui', kind: 'choice', zhTranslation: '直接踏上回家的路' },
];
const L5_SYS: GroundTruthTextEntry[] = [
  { source: 'セーブスロット選択', track: 'ui', kind: 'system', zhTranslation: '选择存档槽位' },
  { source: '設定を初期化しますか？', track: 'ui', kind: 'system', zhTranslation: '是否将设置恢复默认？' },
  { source: '音声再生エラー', track: 'ui', kind: 'system', zhTranslation: '语音播放异常' },
  { source: '既読スキップ有効', track: 'ui', kind: 'system', zhTranslation: '已读快进已开启' },
];
const L5_GROUND_TRUTH: GroundTruthTextEntry[] = [...L5_SAYS, ...L5_NAMES, ...L5_CHOICES, ...L5_SYS];
const L5_INTERNAL_KEYS = ['FLAG_ROUTE_A', 'BGM_TOWN_01', 'SE_DOOR_OPEN', 'CG_KEY_001', 'SYS_VER_100', 'VAR_SCORE'];

interface VmInstr {
  opcode: number;
  arg0: number;
  operand: number;
}

const OP_SHOW_TEXT = 0x0010;
const OP_SET_SPEAKER = 0x0011;
const OP_ADD_CHOICE = 0x0012;
const OP_SHOW_SYS = 0x0013;
const OP_WAIT_MS = 0x0020;
const OP_SET_FLAG = 0x0021;
const OP_JUMP_INSTR = 0x0022;

function buildL5Files(): { textDat: Buffer; scriptVm: Buffer; expectedNonTextOperands: Map<number, number>; textInstrExpectations: Array<{ pc: number; source: string }> } {
  const poolParts: Buffer[] = [];
  const offsetByStr = new Map<string, number>();
  let cursor = 0;

  const appendString = (s: string) => {
    offsetByStr.set(s, cursor);
    const b = Buffer.concat([encodeText(s, 'cp932'), Buffer.from([0])]);
    poolParts.push(b);
    cursor += b.length;
  };

  for (const k of L5_INTERNAL_KEYS.slice(0, 3)) appendString(k);
  for (const gt of L5_GROUND_TRUTH) appendString(gt.source);
  for (const k of L5_INTERNAL_KEYS.slice(3)) appendString(k);

  const textDat = Buffer.concat(poolParts);
  const allOffsets = Array.from(offsetByStr.values());

  const instrs: VmInstr[] = [];
  const expectedNonTextOperands = new Map<number, number>();
  const textInstrExpectations: Array<{ pc: number; source: string }> = [];

  const emitText = (op: number, source: string, arg0 = 0) => {
    const pc = instrs.length;
    instrs.push({ opcode: op, arg0, operand: offsetByStr.get(source)! });
    textInstrExpectations.push({ pc, source });
  };
  const emitNonText = (op: number, operand: number, arg0 = 0) => {
    const pc = instrs.length;
    instrs.push({ opcode: op, arg0, operand });
    expectedNonTextOperands.set(pc, operand);
  };

  // Deliberately plant WAIT_MS / SET_FLAG / JUMP_INSTR whose integer operand EQUALS real TEXT.DAT offsets!
  // Any blind u32 global search-and-replace will corrupt these and FAIL the VM simulator.
  emitNonText(OP_WAIT_MS, allOffsets[3]);
  emitNonText(OP_SET_FLAG, allOffsets[7], 1);

  L5_SAYS.forEach((s, idx) => {
    if (idx % 8 === 0) {
      const nm = L5_NAMES[Math.floor(idx / 8) % L5_NAMES.length];
      emitText(OP_SET_SPEAKER, nm.source, idx);
    }
    emitText(OP_SHOW_TEXT, s.source, idx);
    if (idx === 5) emitNonText(OP_WAIT_MS, allOffsets[12]);
    if (idx === 10) emitNonText(OP_JUMP_INSTR, allOffsets[5]);
    if (idx % 9 === 0) {
      const ch = L5_CHOICES[Math.floor(idx / 9) % L5_CHOICES.length];
      emitText(OP_ADD_CHOICE, ch.source, idx);
    }
  });
  for (const sys of L5_SYS) {
    emitText(OP_SHOW_SYS, sys.source, 1);
  }
  emitNonText(OP_WAIT_MS, allOffsets[18]);

  const vmParts = [Buffer.from('VM01', 'ascii'), u32le(instrs.length)];
  for (const ins of instrs) {
    vmParts.push(u16le(ins.opcode), u16le(ins.arg0), u32le(ins.operand));
  }
  return {
    textDat,
    scriptVm: Buffer.concat(vmParts),
    expectedNonTextOperands,
    textInstrExpectations,
  };
}

const L5_META = buildL5Files();

const L5_TASK: BenchTaskSpec = {
  id: 'L5-pointer-relocation-vm',
  difficulty: 'L5',
  tierName: 'Tier 5 / 极难',
  title: '消费端字节偏移寻址重定位 (SCRIPT.VM -> TEXT.DAT) + 非文本操作数陷阱',
  description: '还原经典同址崩溃根因：SCRIPT.VM 中 0x10..0x13 指令按字节偏移引用 TEXT.DAT，而 0x20..0x22 数值指令故意含与偏移值相等的整数；严禁盲目全局 u32 替换，必须按指令集精准重定位！',
  expectedPipeline: 'direct',
  expectedSourceEncoding: 'cp932',
  hasCustomControlTags: false,
  gameRelDir: 'game',
  minScenarioRecall: 1.0,
  minUiRecall: 0.95,
  groundTruth: L5_GROUND_TRUTH,
  forbiddenExtractedSubstrings: L5_INTERNAL_KEYS,
  buildTaskPrompt: (gameDir) =>
    `工作区 \`${gameDir}/\` 包含字符串池 \`TEXT.DAT\`、伴生字节码 \`SCRIPT.VM\` 与引擎主程序 \`vm_engine.exe\`（无外层封包）。请务必核实消费端寻址机制（字节偏移 vs 槽号），落盘研究记录并编写支持安全变长写回（不破坏字节码寻址与非文本指令操作数）的 extract.py / apply.py（pipeline="direct"，支持 PAPERCUP_TARGET_ENCODING=gbk/cp932/utf-8），通过 vn_learn_skill 完成验证。严禁修改原始文件。`,
  generateFixture: (workspaceDir) => {
    writePapercupToml(workspaceDir);
    const gameDir = path.join(workspaceDir, 'game');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'TEXT.DAT'), L5_META.textDat);
    fs.writeFileSync(path.join(gameDir, 'SCRIPT.VM'), L5_META.scriptVm);

    const { buf: rdata, vaByText } = packRdataStrings([
      'TEXT.DAT',
      'SCRIPT.VM',
      'VM01',
      'SHOW_TEXT',
      'SET_SPEAKER',
      'ADD_CHOICE',
      'SHOW_SYS',
      'WAIT_MS',
      'SET_FLAG',
      'JUMP_INSTR',
    ]);
    // Authentic x86-32 opcode dispatch comparing ax against 0x0010..0x0013 (adds operand to TEXT.DAT base esi) vs 0x0020..0x0022
    const textCode = Buffer.concat([
      pushVa(vaByText.get('VM01')!),
      pushVa(vaByText.get('TEXT.DAT')!),
      pushVa(vaByText.get('SCRIPT.VM')!),
      Buffer.from([
        0x66, 0x3d, 0x10, 0x00, // cmp ax, 0x0010 (SHOW_TEXT)
        0x74, 0x12,             // je deref_text
        0x66, 0x3d, 0x11, 0x00, // cmp ax, 0x0011 (SET_SPEAKER)
        0x74, 0x0c,             // je deref_text
        0x66, 0x3d, 0x12, 0x00, // cmp ax, 0x0012 (ADD_CHOICE)
        0x74, 0x06,             // je deref_text
        0x66, 0x3d, 0x13, 0x00, // cmp ax, 0x0013 (SHOW_SYS)
        0x75, 0x05,             // jne non_text
        // deref_text: eax = esi (TEXT.DAT) + edx (operand byte offset)
        0x8d, 0x04, 0x16,       // lea eax, [esi+edx]
        0xc3,                   // ret
        // non_text:
        0x66, 0x3d, 0x20, 0x00, // cmp ax, 0x0020 (WAIT_MS)
        0x66, 0x3d, 0x21, 0x00, // cmp ax, 0x0021 (SET_FLAG)
        0x66, 0x3d, 0x22, 0x00, // cmp ax, 0x0022 (JUMP_INSTR)
        0xc3,                   // ret
      ]),
    ]);
    fs.writeFileSync(path.join(gameDir, 'vm_engine.exe'), buildMinimalPeExe(textCode, rdata));
  },
  verifyConsumer: ({ patchedGameDir, appliedEncoding, expectedBySource }): ConsumerVerificationResult => {
    const errors: string[] = [];
    let checked = 0;
    try {
      const textDat = fs.readFileSync(path.join(patchedGameDir, 'TEXT.DAT'));
      const scriptVm = fs.readFileSync(path.join(patchedGameDir, 'SCRIPT.VM'));
      if (scriptVm.subarray(0, 4).toString('ascii') !== 'VM01') {
        return { ok: false, checkedCount: 0, errors: ['SCRIPT.VM 魔数损坏'] };
      }
      const count = scriptVm.readUInt32LE(4);
      const expectedTotalInstrs = L5_META.textInstrExpectations.length + L5_META.expectedNonTextOperands.size;
      if (count !== expectedTotalInstrs) {
        return { ok: false, checkedCount: 0, errors: [`SCRIPT.VM 指令数异常: 期望 ${expectedTotalInstrs}, 实际 ${count}`] };
      }

      // Build valid NUL-terminated string-start set to detect mid-string dereferencing
      const validStarts = new Set<number>([0]);
      for (let i = 0; i < textDat.length - 1; i++) {
        if (textDat[i] === 0) validStarts.add(i + 1);
      }

      const textExpByPc = new Map(L5_META.textInstrExpectations.map((e) => [e.pc, e.source]));
      for (let pc = 0; pc < count; pc++) {
        const base = 8 + pc * 8;
        const op = scriptVm.readUInt16LE(base);
        const operand = scriptVm.readUInt32LE(base + 4);

        if (L5_META.expectedNonTextOperands.has(pc)) {
          const origInt = L5_META.expectedNonTextOperands.get(pc)!;
          if (operand !== origInt) {
            errors.push(`非文本指令 PC=${pc} (opcode=0x${op.toString(16)}) 操作数被误改: 期望 ${origInt}, 实际 ${operand}（疑似盲目全局 u32 替换）`);
          }
          continue;
        }
        const src = textExpByPc.get(pc);
        if (!src) continue;
        if (operand >= textDat.length || !validStarts.has(operand)) {
          errors.push(`文本指令 PC=${pc} 字节偏移 0x${operand.toString(16)} 未对齐到有效字符串起始位置（越界或错位崩溃）`);
          continue;
        }
        const nul = textDat.indexOf(0, operand);
        if (nul < 0) {
          errors.push(`文本指令 PC=${pc} 偏移 0x${operand.toString(16)} 缺少 NUL 终止符`);
          continue;
        }
        const actual = decodeStrict(textDat.subarray(operand, nul), appliedEncoding);
        const expected = normalizeExpectedForEncoding(expectedBySource.get(src) ?? src, appliedEncoding);
        if (actual !== expected) {
          errors.push(`VM 执行 PC=${pc} 解引用结果错误: 期望 "${expected.slice(0, 40)}", 实际 "${actual.slice(0, 40)}"`);
        } else {
          checked += 1;
        }
      }
    } catch (err: any) {
      errors.push(`VM 消费端执行异常: ${err?.message || String(err)}`);
    }
    return { ok: errors.length === 0, checkedCount: checked, errors };
  },
};

/* ========================= L6: Full Gauntlet (Multi-Archive LCG+Zlib + Offset BCOD + Obfuscated MSGB + Custom Ruby + Raster UI) ========================= */

const L6_SAYS = buildDialogueSet('L6', 32, 'ruby');
const L6_NAMES: GroundTruthTextEntry[] = [
  { source: 'イリス', track: 'ui', kind: 'name', zhTranslation: '伊莉丝' },
  { source: 'カイト', track: 'ui', kind: 'name', zhTranslation: '海斗' },
  { source: 'ルナ', track: 'ui', kind: 'name', zhTranslation: '露娜' },
  { source: 'レイジ', track: 'ui', kind: 'name', zhTranslation: '零司' },
];
const L6_SYS: GroundTruthTextEntry[] = [
  { source: 'セーブデータ保存', track: 'ui', kind: 'system', zhTranslation: '保存游戏进度' },
  { source: 'セーブデータ読込', track: 'ui', kind: 'system', zhTranslation: '读取游戏进度' },
  { source: '音量調整メニュー', track: 'ui', kind: 'system', zhTranslation: '音量调节菜单' },
  { source: '表示速度設定', track: 'ui', kind: 'system', zhTranslation: '文本显示速度设置' },
  { source: 'タイトル画面に戻る', track: 'ui', kind: 'system', zhTranslation: '返回主标题界面' },
  { source: 'ゲームを終了する', track: 'ui', kind: 'system', zhTranslation: '退出当前游戏' },
];
const L6_GROUND_TRUTH: GroundTruthTextEntry[] = [...L6_SAYS, ...L6_NAMES, ...L6_SYS];
const L6_UI_KEYS = ['UI_SAVE', 'UI_LOAD', 'UI_VOL', 'UI_SPD', 'UI_TITLE', 'UI_EXIT'];
const L6_DBG_DECOYS = [
  'DBG_INIT_PIPELINE_OK',
  'DBG_SHADER_COMPILED',
  'DBG_AUDIO_BANK_READY',
  '(internal) Engine::MountArchive("data_scn.pak")',
  'DBG_CHECKPOINT_ALPHA',
];

function lcgXor(buf: Buffer, seed: number): Buffer {
  let state = seed >>> 0;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = buf[i] ^ ((state >>> 24) & 0xff);
  }
  return out;
}

function packGpk3Archive(entries: Array<{ name: string; data: Buffer }>, seed: number): Buffer {
  const tocEntries: Buffer[] = [];
  const compPayloads: Buffer[] = [];
  let relOff = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const comp = zlib.deflateSync(e.data);
    const enc = lcgXor(comp, (seed + i + 1) >>> 0);
    const nb = Buffer.from(e.name, 'ascii');
    tocEntries.push(Buffer.concat([u16le(nb.length), nb, u32le(relOff), u32le(enc.length), u32le(e.data.length)]));
    compPayloads.push(enc);
    relOff += enc.length;
  }
  const plainToc = Buffer.concat(tocEntries);
  const encToc = lcgXor(plainToc, seed);
  return Buffer.concat([
    Buffer.from('GPK3', 'ascii'),
    u32le(seed),
    u32le(entries.length),
    u32le(plainToc.length),
    encToc,
    ...compPayloads,
  ]);
}

function unpackGpk3Archive(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 16 || buf.subarray(0, 4).toString('ascii') !== 'GPK3') {
    throw new Error('GPK3 魔数错误');
  }
  const seed = buf.readUInt32LE(4);
  const count = buf.readUInt32LE(8);
  const tocLen = buf.readUInt32LE(12);
  const plainToc = lcgXor(buf.subarray(16, 16 + tocLen), seed);
  const bodyStart = 16 + tocLen;
  const out = new Map<string, Buffer>();
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const nlen = plainToc.readUInt16LE(pos);
    pos += 2;
    const name = plainToc.subarray(pos, pos + nlen).toString('ascii');
    pos += nlen;
    const off = plainToc.readUInt32LE(pos);
    const compLen = plainToc.readUInt32LE(pos + 4);
    const uncompLen = plainToc.readUInt32LE(pos + 8);
    pos += 12;
    const decComp = lcgXor(buf.subarray(bodyStart + off, bodyStart + off + compLen), (seed + i + 1) >>> 0);
    const raw = zlib.inflateSync(decComp);
    if (raw.length !== uncompLen) throw new Error(`GPK3 条目 ${name} 解压长度不匹配`);
    out.set(name, raw);
  }
  return out;
}

function xorMsgbRecord(buf: Buffer, recordIndex: number): Buffer {
  const key = (recordIndex * 0x1d + 0x53) & 0xff;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
  return out;
}

function buildL6ScbAndUis(): {
  scb: Buffer;
  uis: Buffer;
  scbTextInstrs: Array<{ pc: number; source: string }>;
  scbTrapInstrs: Map<number, number>;
} {
  // MSGB records: {u16 byteLen, xor'd bytes} sequentially, referenced by byte offset from start of MSGB payload
  const msgbEntries = [...L6_NAMES, ...L6_SAYS];
  const msgbParts: Buffer[] = [];
  const offBySource = new Map<string, number>();
  let cursor = 0;
  msgbEntries.forEach((entry, idx) => {
    offBySource.set(entry.source, cursor);
    const plain = encodeText(entry.source, 'cp932');
    const enc = xorMsgbRecord(plain, idx);
    msgbParts.push(u16le(enc.length), enc);
    cursor += 2 + enc.length;
  });
  const msgbPayload = Buffer.concat([u32le(msgbEntries.length), ...msgbParts]);

  const instrs: VmInstr[] = [];
  const scbTextInstrs: Array<{ pc: number; source: string }> = [];
  const scbTrapInstrs = new Map<number, number>();
  const offsets = Array.from(offBySource.values());

  // Plant non-text opcode 0x09 whose operand equals a real MSGB byte offset
  scbTrapInstrs.set(0, offsets[4]);
  instrs.push({ opcode: 0x0009, arg0: 0, operand: offsets[4] });

  L6_SAYS.forEach((s, idx) => {
    if (idx % 8 === 0) {
      const nm = L6_NAMES[Math.floor(idx / 8) % L6_NAMES.length];
      scbTextInstrs.push({ pc: instrs.length, source: nm.source });
      instrs.push({ opcode: 0x0002, arg0: idx, operand: offBySource.get(nm.source)! });
    }
    scbTextInstrs.push({ pc: instrs.length, source: s.source });
    instrs.push({ opcode: 0x0001, arg0: idx, operand: offBySource.get(s.source)! });
    if (idx === 15) {
      scbTrapInstrs.set(instrs.length, offsets[9]);
      instrs.push({ opcode: 0x0009, arg0: 1, operand: offsets[9] });
    }
  });

  const bcodPayload = Buffer.concat([
    u32le(instrs.length),
    ...instrs.map((ins) => Buffer.concat([u16le(ins.opcode), u16le(ins.arg0), u32le(ins.operand)])),
  ]);
  const dbgPayload = Buffer.concat([
    u32le(L6_DBG_DECOYS.length),
    ...L6_DBG_DECOYS.map((s) => Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0])])),
  ]);

  const scb = Buffer.concat([
    Buffer.from('SCB1', 'ascii'),
    Buffer.from('BCOD', 'ascii'),
    u32le(bcodPayload.length),
    bcodPayload,
    Buffer.from('MSGB', 'ascii'),
    u32le(msgbPayload.length),
    msgbPayload,
    Buffer.from('DBG0', 'ascii'),
    u32le(dbgPayload.length),
    dbgPayload,
  ]);

  // UIS1 table
  const uisParts: Buffer[] = [Buffer.from('UIS1', 'ascii'), u32le(L6_SYS.length)];
  L6_SYS.forEach((s, i) => {
    const kb = Buffer.from(L6_UI_KEYS[i], 'ascii');
    const vb = encodeText(s.source, 'cp932');
    uisParts.push(u16le(kb.length), kb, u16le(vb.length), vb);
  });

  return { scb, uis: Buffer.concat(uisParts), scbTextInstrs, scbTrapInstrs };
}

const L6_META = buildL6ScbAndUis();

const L6_TASK: BenchTaskSpec = {
  id: 'L6-full-gauntlet',
  difficulty: 'L6',
  tierName: 'Tier 6 / 地狱',
  title: '综合地狱关：多封包 LCG+Zlib (GPK3) + 字节偏移 BCOD + 混淆 MSGB + 自定义 Ruby 标签 + 栅格 UI',
  description: '最高难度综合验收：双封包同引擎 LCG 加密压缩、二进制字节码偏移重定位、按记录索引混淆的剧情池、诱饵 DBG0、二进制键值 UI 表、自定义 <ruby .../> 控制符注册与栅格 PNG 保真。',
  expectedPipeline: 'skill',
  expectedSourceEncoding: 'cp932',
  hasCustomControlTags: true,
  gameRelDir: 'game',
  archiveRelPaths: ['game/data_scn.pak', 'game/data_sys.pak'],
  rasterAssetRelPaths: ['ui/title_menu.png'],
  minScenarioRecall: 1.0,
  minUiRecall: 0.95,
  groundTruth: L6_GROUND_TRUTH,
  forbiddenExtractedSubstrings: [...L6_DBG_DECOYS, ...L6_UI_KEYS, 'title_menu.png'],
  buildTaskPrompt: (gameDir) =>
    `工作区 \`${gameDir}/\` 包含双自定义封包 \`data_scn.pak\`、\`data_sys.pak\` 以及引擎主程序 \`gauntlet.exe\`。请逆向完整封包加密压缩格式、编译剧本与 UI 二进制表结构（注意消费端字节偏移、混淆剧情区段、自定义控制标签与图片型 UI），落盘研究文档与 unpack.py / repack.py / extract.py / apply.py（pipeline="skill"，支持 PAPERCUP_TARGET_ENCODING=gbk/cp932/utf-8），并通过 vn_learn_skill 注册完整技能与 controlPattern。严禁修改原始文件。`,
  generateFixture: (workspaceDir) => {
    writePapercupToml(workspaceDir);
    const gameDir = path.join(workspaceDir, 'game');
    fs.mkdirSync(gameDir, { recursive: true });

    const scnPak = packGpk3Archive([{ name: 'scn/prologue.scb', data: L6_META.scb }], 0x20261122);
    const sysPak = packGpk3Archive(
      [
        { name: 'ui/strings.bin', data: L6_META.uis },
        { name: 'ui/title_menu.png', data: MINIMAL_PNG },
      ],
      0x13572468
    );
    fs.writeFileSync(path.join(gameDir, 'data_scn.pak'), scnPak);
    fs.writeFileSync(path.join(gameDir, 'data_sys.pak'), sysPak);

    const { buf: rdata, vaByText } = packRdataStrings(['GPK3', 'SCB1', 'BCOD', 'MSGB', 'DBG0', 'UIS1']);
    const textCode = Buffer.concat([
      // Function 1: GPK3 per-entry seed (seed + entryIdx + 1) + LCG XOR stream
      pushVa(vaByText.get('GPK3')!),
      Buffer.from([
        0x8d, 0x44, 0x33, 0x01,             // lea eax, [ebx+esi+1]  (entrySeed = headerSeed + entryIdx + 1)
        0x69, 0xc0, 0x0d, 0x66, 0x19, 0x00, // imul eax, eax, 1664525 (0x0019660D)
        0x05, 0x5f, 0xf3, 0x6e, 0x3c,       // add eax, 1013904223 (0x3C6EF35F)
        0x89, 0xc2,                         // mov edx, eax
        0xc1, 0xea, 0x18,                   // shr edx, 24
        0x30, 0x14, 0x0f,                   // xor [edi+ecx], dl
        0xc3,                               // ret
      ]),
      // Function 2: MSGB per-record XOR: key = (recIdx * 0x1D + 0x53) & 0xFF
      pushVa(vaByText.get('MSGB')!),
      Buffer.from([
        0x6b, 0xc2, 0x1d,                   // imul eax, edx, 0x1D
        0x04, 0x53,                         // add al, 0x53
        0x30, 0x04, 0x0e,                   // xor [esi+ecx], al
        0xc3,                               // ret
      ]),
      // Function 3: BCOD opcode dispatch (0x01/0x02/0x03 byte-offset into MSGB vs 0x09 delay)
      pushVa(vaByText.get('BCOD')!),
      Buffer.from([
        0x66, 0x3d, 0x01, 0x00,             // cmp ax, 0x0001
        0x66, 0x3d, 0x02, 0x00,             // cmp ax, 0x0002
        0x66, 0x3d, 0x03, 0x00,             // cmp ax, 0x0003
        0x8d, 0x04, 0x16,                   // lea eax, [esi+edx]
        0x66, 0x3d, 0x09, 0x00,             // cmp ax, 0x0009
        0xc3,                               // ret
      ]),
    ]);
    fs.writeFileSync(path.join(gameDir, 'gauntlet.exe'), buildMinimalPeExe(textCode, rdata));
  },
  verifyConsumer: ({ patchedGameDir, appliedEncoding, expectedBySource }): ConsumerVerificationResult => {
    const errors: string[] = [];
    let checked = 0;
    try {
      // 1) Verify data_sys.pak (UIS1 + untouched PNG)
      const sysFiles = unpackGpk3Archive(fs.readFileSync(path.join(patchedGameDir, 'data_sys.pak')));
      const png = sysFiles.get('ui/title_menu.png');
      if (!png || !png.equals(MINIMAL_PNG)) errors.push('data_sys.pak 中 ui/title_menu.png 被破坏或丢失');
      const uis = sysFiles.get('ui/strings.bin');
      if (!uis || uis.subarray(0, 4).toString('ascii') !== 'UIS1') {
        errors.push('data_sys.pak 中 ui/strings.bin 魔数损坏');
      } else {
        const uCount = uis.readUInt32LE(4);
        let up = 8;
        const uiMap = new Map<string, string>();
        for (let i = 0; i < uCount; i++) {
          const kl = uis.readUInt16LE(up);
          up += 2;
          const key = uis.subarray(up, up + kl).toString('ascii');
          up += kl;
          const vl = uis.readUInt16LE(up);
          up += 2;
          const val = decodeStrict(uis.subarray(up, up + vl), appliedEncoding);
          up += vl;
          uiMap.set(key, val);
        }
        L6_SYS.forEach((s, i) => {
          const expected = normalizeExpectedForEncoding(expectedBySource.get(s.source) ?? s.source, appliedEncoding);
          const actual = uiMap.get(L6_UI_KEYS[i]);
          if (actual !== expected) {
            errors.push(`UIS1[${L6_UI_KEYS[i]}] 不匹配: 期望 "${expected.slice(0, 40)}", 实际 "${String(actual).slice(0, 40)}"`);
          } else {
            checked += 1;
          }
        });
      }

      // 2) Verify data_scn.pak (SCB1: BCOD byte-offset execution + MSGB decryption + DBG0 intact)
      const scnFiles = unpackGpk3Archive(fs.readFileSync(path.join(patchedGameDir, 'data_scn.pak')));
      const scb = scnFiles.get('scn/prologue.scb');
      if (!scb || scb.subarray(0, 4).toString('ascii') !== 'SCB1') {
        errors.push('data_scn.pak 中 scn/prologue.scb 魔数损坏');
        return { ok: false, checkedCount: checked, errors };
      }
      let p = 4;
      if (scb.subarray(p, p + 4).toString('ascii') !== 'BCOD') throw new Error('缺少 BCOD');
      const bcodLen = scb.readUInt32LE(p + 4);
      const bcod = scb.subarray(p + 8, p + 8 + bcodLen);
      p += 8 + bcodLen;

      if (scb.subarray(p, p + 4).toString('ascii') !== 'MSGB') throw new Error('缺少 MSGB');
      const msgbLen = scb.readUInt32LE(p + 4);
      const msgb = scb.subarray(p + 8, p + 8 + msgbLen);
      p += 8 + msgbLen;

      if (scb.subarray(p, p + 4).toString('ascii') !== 'DBG0') throw new Error('缺少 DBG0');
      const dbgLen = scb.readUInt32LE(p + 4);
      const dbg = scb.subarray(p + 8, p + 8 + dbgLen);
      if (!dbg.includes(Buffer.from('DBG_INIT_PIPELINE_OK', 'ascii'))) {
        errors.push('DBG0 调试区段被破坏');
      }

      // Parse MSGB records by offset
      const msgCount = msgb.readUInt32LE(0);
      const recordByOffset = new Map<number, string>();
      let mp = 4;
      for (let idx = 0; idx < msgCount; idx++) {
        const relOff = mp - 4;
        const rlen = msgb.readUInt16LE(mp);
        mp += 2;
        const dec = xorMsgbRecord(msgb.subarray(mp, mp + rlen), idx);
        mp += rlen;
        recordByOffset.set(relOff, decodeStrict(dec, appliedEncoding));
      }

      // Execute BCOD instructions
      const iCount = bcod.readUInt32LE(0);
      const textExpByPc = new Map(L6_META.scbTextInstrs.map((e) => [e.pc, e.source]));
      for (let pc = 0; pc < iCount; pc++) {
        const off = 4 + pc * 8;
        const op = bcod.readUInt16LE(off);
        const operand = bcod.readUInt32LE(off + 4);
        if (L6_META.scbTrapInstrs.has(pc)) {
          const orig = L6_META.scbTrapInstrs.get(pc)!;
          if (operand !== orig) {
            errors.push(`BCOD 非文本指令 PC=${pc} (op=0x${op.toString(16)}) 被误改: 期望 ${orig}, 实际 ${operand}`);
          }
          continue;
        }
        const src = textExpByPc.get(pc);
        if (!src) continue;
        const actual = recordByOffset.get(operand);
        const expected = normalizeExpectedForEncoding(expectedBySource.get(src) ?? src, appliedEncoding);
        if (actual !== expected) {
          errors.push(`BCOD PC=${pc} 偏移 0x${operand.toString(16)} 解引用错误: 期望 "${expected.slice(0, 40)}", 实际 "${String(actual).slice(0, 40)}"`);
        } else {
          checked += 1;
        }
      }
    } catch (err: any) {
      errors.push(`GPK3/SCB1 消费端执行失败: ${err?.message || String(err)}`);
    }
    return { ok: errors.length === 0, checkedCount: checked, errors };
  },
};

export const BENCH_TASKS: readonly BenchTaskSpec[] = [
  L1_TASK,
  L2_TASK,
  L3_TASK,
  L4_TASK,
  L5_TASK,
  L6_TASK,
];

export function selectBenchTasks(filterIds?: string[]): BenchTaskSpec[] {
  if (!filterIds || filterIds.length === 0) return [...BENCH_TASKS];
  const wanted = new Set(filterIds.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const selected = BENCH_TASKS.filter(
    (t) => wanted.has(t.id.toLowerCase()) || wanted.has(t.difficulty.toLowerCase())
  );
  if (selected.length === 0) {
    throw new Error(
      `未匹配到任何题目：${filterIds.join(', ')}。可选题目：${BENCH_TASKS.map((t) => `${t.difficulty} (${t.id})`).join(', ')}`
    );
  }
  return selected;
}
