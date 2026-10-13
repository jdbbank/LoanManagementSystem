import { Request, Response } from 'express';
import multer from 'multer';
import { AppError, badRequest } from './errors';

/**
 * busboy hands the multipart filename over as latin1, so a Thai/Lao name arrives as mojibake.
 * Re-read those bytes as UTF-8 and keep the original only if the result is not valid UTF-8.
 */
function decodeFileName(name: string): string {
  const rebuilt = Buffer.from(name, 'latin1').toString('utf8');
  return rebuilt.includes('\uFFFD') ? name : rebuilt;
}

/**
 * One multipart field ("file") read straight into memory, sized against a runtime
 * policy so a config change takes effect without a restart. Shared by KYC evidence
 * and staff avatars — both accept images only.
 */
export function readSingleFile(
  req: Request,
  res: Response,
  maxFileSizeKb: number,
  maxFiles = 1,
): Promise<Express.Multer.File> {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSizeKb * 1024, files: maxFiles },
  }).single('file');

  return new Promise<Express.Multer.File>((resolve, reject) => {
    handler(req, res, (error: unknown) => {
      if (error) {
        if (error instanceof multer.MulterError) {
          reject(
            error.code === 'LIMIT_FILE_SIZE'
              ? new AppError(413, `File is larger than the configured limit of ${maxFileSizeKb} KB`)
              : badRequest(`Upload rejected: ${error.message}`),
          );
          return;
        }
        reject(error);
        return;
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file || file.size === 0) {
        reject(badRequest('No file received — send the image in the multipart field "file"'));
        return;
      }
      resolve({ ...file, originalname: decodeFileName(file.originalname) });
    });
  });
}
