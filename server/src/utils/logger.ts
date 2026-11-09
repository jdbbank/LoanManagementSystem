/**
 * ตัวกลางบันทึก log ของระบบทั้งเซิร์ฟเวอร์ (winston + dayjs)
 * ทุกลำดับงานถัดไปของ mail / OTP / report ให้เรียก logger จากไฟล์นี้ที่เดียว
 */
import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import * as winston from 'winston';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

// dayjs ต้องต่อปลั๊กอิน utc + timezone ก่อนจึงจะแปลงเขตเวลาได้ถูกต้อง
dayjs.extend(utc);
dayjs.extend(timezone);

/** เขตเวลาที่ใช้งานจริงคือเวลาไทย ใช้ทั้งในข้อความ log และชื่อไฟล์ log */
const TIMEZONE = 'Asia/Bangkok';

/** รูปแบบเวลาในบรรทัด log: YYYY-MM-DD HH:mm:ss */
const TIMESTAMP_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/** ชื่อไฟล์ log ต่อชั่วโมง: YYYYMMDDHH_apiOpenWay.log */
const FILE_HOUR_FORMAT = 'YYYYMMDDHH';
const FILE_PREFIX = 'LoanSystem';

/** ความกว้างของช่อง [LEVEL  ] เพื่อให้ทุกบรรทัดตรงกัน */
const LEVEL_WIDTH = 7;

// โฟลเดอร์ logs สร้างอัตโนมัติโดยอ้างอิงตำแหน่ง ../logs เทียบกับไฟล์นี้
const LOG_DIR = path.resolve(__dirname, '..', 'logs');

/** สร้างโฟลเดอร์ logs ครั้งเดียวตอนโหลดโมดูล */
function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
ensureLogDir();

/** คืนเวลาปัจจุบันในเขตเวลาไทยตามรูปแบบที่สเปกกำหนด */
function bangkokTimestamp(format: string): string {
  return dayjs().tz(TIMEZONE).format(format);
}

// ไฟล์ log เปลี่ยนตามชั่วโมง จึงถือ stream ไว้ตัวเดียวแล้วสลับเมื่อข้ามชั่วโมง
let activeFileName = '';
let activeFileStream: fs.WriteStream | null = null;

/** เขียนบรรทัด log ลงไฟล์ของชั่วโมงปัจจุบัน หากข้ามชั่วโมงให้เปิดไฟล์ใหม่ */
function appendToHourlyFile(line: string): void {
  const targetPath = path.join(
    LOG_DIR,
    `${bangkokTimestamp(FILE_HOUR_FORMAT)}_${FILE_PREFIX}.log`,
  );

  if (activeFileStream && targetPath === activeFileName) {
    activeFileStream.write(`${line}\n`);
    return;
  }

  // ข้ามชั่วโมง: ปิดไฟล์เดิมแล้วเปิดไฟล์ใหม่ของชั่วโมงปัจจุบัน
  if (activeFileStream) activeFileStream.end();
  const stream = fs.createWriteStream(targetPath, { flags: 'a' });
  activeFileStream = stream;
  activeFileName = targetPath;
  stream.write(`${line}\n`);
}

// winston ส่งผ่าน Stream transport ได้ จึงใช้ Writable ตัวนี้เป็น File transport แบบแยกรายชั่วโมง
const hourlyFileStream = new Writable({
  write(chunk, _encoding, callback): void {
    try {
      appendToHourlyFile(String(chunk));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  },
});

/** แปลง message ให้เป็นข้อความเดียวอ่านได้ รองรับ case ที่ส่ง Error เข้ามา */
function renderMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.stack ?? message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * ชั้นป้องกันสุดท้ายก่อนถึงดิสก์: ค่าลับ (OTP ใน subject, token ใน URL reset link)
 * ต้องไม่ถูกเขียนลงไฟล์ log แม้ผู้เรียกในอนาคตเผลอส่งข้อความดิบมา
 * การ redaction หลักยังอยู่ที่ notification-dispatcher (SECRET_EVENT_TYPES)
 */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replace: string }> = [
  { pattern: /(ເລກຢືນຢັນ\s*)\d{6}/g, replace: '$1<redacted>' },
  { pattern: /((?:verification|one[-\s]time) code\D{0,4})\d{6}/gi, replace: '$1<redacted>' },
  { pattern: /(reset-password\?token=)[A-Za-z0-9_-]{8,}/g, replace: '$1<redacted>' },
];

export function redactSecretsFrom(message: string): string {
  return SECRET_PATTERNS.reduce((text, { pattern, replace }) => text.replace(pattern, replace), message);
}

const redactSecrets = winston.format((info) =>
  typeof info.message === 'string' ? { ...info, message: redactSecretsFrom(info.message) } : info,
);

/** รูปแบบ output: YYYY-MM-DD HH:mm:ss [LEVEL  ]: message */
const logFormat = winston.format.combine(
  redactSecrets(),
  winston.format.printf((info) => {
    const level = String(info.level).toUpperCase().padEnd(LEVEL_WIDTH);
    return `${info.timestamp} [${level}]: ${renderMessage(info.message)}`;
  }),
);

/**
 * console แสดงทุกระดับ (silly) เพื่อให้ดีบักได้เต็ม
 * ไฟล์เก็บเฉพาะ info ขึ้นไป เพื่อไม่ให้ log บนดิสก์โตเร็วเกินจำเป็น
 */
const transports: winston.transport[] = [
  new winston.transports.Console({ level: 'silly', format: logFormat }),
  new winston.transports.Stream({ stream: hourlyFileStream, level: 'info', format: logFormat }),
];

export const logger = winston.createLogger({
  level: 'silly',
  // meta เริ่มต้นกำกับเวลาไทยไว้ทุก entry แม้ผู้เรียกจะไม่ส่งเวลามาก็ตาม
  defaultMeta: { timezone: TIMEZONE, timestamp: bangkokTimestamp(TIMESTAMP_FORMAT) },
  format: winston.format.combine(
    winston.format.timestamp({ format: () => bangkokTimestamp(TIMESTAMP_FORMAT) }),
    logFormat,
  ),
  transports,
  // ช่วงรันเทสต์ปิดการเขียน log ลงไฟล์ เพื่อไม่ให้ปะปนกับข้อมูลจริง
  silent: process.env.NODE_ENV === 'test',
});
