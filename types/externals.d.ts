// 型定義を持たない上流モジュールを宣言する。
//
// いずれも型定義を同梱しない（2026-08-18 時点）。宣言を置かないと取り込みの行そのものが
// 検査を止めるため、any として通す。
//
// jsdom だけは DefinitelyTyped に @types/jsdom が在る（当初「無い」と書いたのは確認を
// 怠った誤りで、CP6 レビューで指摘された）。入れれば env.ts の 1 箇所が型を得るが、
// 得られる型は本体の設計に効かない（大域へ window を置くための足場としてしか使わない）。
// 入れていない理由をここに残し、必要になったら足す。
//
// any で通すことは、その先の呼び出しが検査されないことを意味する。何を検査できて
// いないかを見えるようにするため、ここへ 1 行ずつ理由とともに並べる。

// ブラウザの DOM を模す。scratchblocks が大域の window を要求するために使う
declare module "jsdom"

// 記法の解析と描画。ES 版を明示して読み込むため、パスつきで宣言する
declare module "scratchblocks/build/scratchblocks.min.es.js"

// 記法の定義表。opcode と記法の対応の一次情報
declare module "scratchblocks/syntax/commands.js"

// .sb3 のブロックを記法へ戻す。逆変換の中核
declare module "parse-sb3-blocks"

// 公式の .sb3 検証器
declare module "scratch-parser"
