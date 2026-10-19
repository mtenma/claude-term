// 更新の署名を確かめる公開鍵(Ed25519、raw 32 バイトの base64)。秘密鍵は GitHub の環境 release の Secret と、
// 作った人の ~/.claude-term-release/ だけにある(docs/release.md)。鍵が無い間は、更新を確かめに行かない。
// 鍵を替えるときは、新しい鍵を足した版を古い鍵で署名して配り、行き渡ってから古い鍵を外す
export const UPDATE_PUBLIC_KEYS: readonly string[] = ['uJR1QW4xzpb672d/2diDpYkCS070ny47OvplB0jc8SE=']
