import { createReadStream } from 'node:fs';

/**
 * 从字节偏移 offset 起逐行读取，onLine(line) 回调每行内容（不含换行符，也不含 CR，
 * 也不含文件开头的 UTF-8 BOM）。
 * 字节精确：offset 只推进到最后一个 '\n' 之后；正在写入的半行下次重读。
 * CRLF（Windows JSONL 常见）把 '\r' 留在行内容里会让部分字符串匹配失败；这里剥掉行尾 CR，
 * 但 offset 仍按真实字节（含 \r\n）推进。
 * BOM 只可能出现在文件首行（#96：Pi 的 `type=session` 首行带 BOM 时 JSON.parse 抛错，
 * project 因此永久为 null——而增量扫描不重读首行，此后每轮都补不回来），所以只在
 * offset === 0 的第一行剥掉 EF BB BF，字节游标仍按真实长度推进。
 * 跨 chunk 的 UTF-8 多字节字符安全（leftover 保持 Buffer）。
 * 返回 { newOffset }。
 */
export function readLinesFrom(path, offset, onLine) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start: offset });
    let pos = offset;
    let leftover = null; // Buffer
    let firstLine = offset === 0;
    stream.on('data', (chunk) => {
      const buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      let start = 0;
      let idx;
      while ((idx = buf.indexOf(0x0a, start)) !== -1) {
        let line = buf.subarray(start, idx);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        if (firstLine) {
          firstLine = false;
          if (line.length >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) {
            line = line.subarray(3);
          }
        }
        onLine(line.toString('utf8'));
        start = idx + 1;
      }
      if (start > 0) {
        pos += start;
        leftover = start < buf.length ? buf.subarray(start) : null;
      } else {
        leftover = buf;
      }
    });
    stream.on('end', () => resolve({ newOffset: pos }));
    stream.on('error', reject);
  });
}
