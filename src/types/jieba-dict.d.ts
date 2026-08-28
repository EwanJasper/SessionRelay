// @node-rs/jieba v2 的 dict 子模块未在 exports 中声明类型（运行时正常），此处补环境声明
declare module '@node-rs/jieba/dict.js' {
  export const dict: Uint8Array;
  export const idf: Uint8Array;
}
