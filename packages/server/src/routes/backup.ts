import type { FastifyPluginAsync } from 'fastify';
import { createBackup, restoreBackup, getBackupStatus } from '../services/backupService.js';
import path from 'path';
import fs from 'fs';
import { reqDb, reqSqlite, reqCtx } from '../tenantContext.js';

export const backupRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user || request.user.role !== 'admin') {
      return reply.status(403).send({ success: false, error: 'Yedekleme ve geri yükleme işlemleri yalnızca yönetici tarafından yapılabilir.' });
    }
  });

  // Get backup health status and list of backups
  fastify.get('/status', {
    schema: {
      tags: ['Yedekleme'],
      summary: 'Yedekleme sağlık durumu ve mevcut yedekler'
    }
  }, async () => {
    const status = await getBackupStatus();
    return { success: true, status };
  });

  // Trigger immediate backup now
  fastify.post('/now', {
    schema: {
      tags: ['Yedekleme'],
      summary: 'Hemen yedek al (VACUUM INTO + ZIP)'
    }
  }, async (request, reply) => {
    try {
      const result = await createBackup(undefined, reqCtx(request));
      return { success: true, message: 'Yedekleme başarıyla tamamlandı.', result };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // Download a specific backup zip file
  fastify.get('/download/:filename', {
    schema: {
      tags: ['Yedekleme'],
      summary: 'Yedek ZIP dosyasını indir'
    }
  }, async (request, reply) => {
    const filename = path.basename(String((request.params as any).filename || ''));
    const status = await getBackupStatus();
    const item = status.backups.find((b) => b.filename === filename);
    if (!item || !fs.existsSync(item.fullPath)) {
      return reply.status(404).send({ success: false, error: 'Yedek dosyası bulunamadı.' });
    }
    return reply
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .type('application/zip')
      .send(fs.createReadStream(item.fullPath));
  });

  // Download the raw SQLite database file (live consistent snapshot)
  fastify.get('/export-db', {
    schema: {
      tags: ['Yedekleme'],
      summary: 'Ham SQLite veritabanı dosyasını indir (.sqlite)'
    }
  }, async (request, reply) => {
    const sqlite = reqSqlite(request);
    const buf = sqlite.serialize();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return reply
      .header('Content-Disposition', `attachment; filename="oto-servis-${stamp}.sqlite"`)
      .type('application/x-sqlite3')
      .send(buf);
  });

  // Restore from a specific backup file
  fastify.post('/restore', {
    schema: {
      tags: ['Yedekleme'],
      summary: 'Seçilen yedekten sistemi geri yükle'
    }
  }, async (request, reply) => {
    const filename = (request.body as any)?.filename;
    if (!filename) {
      return reply.status(400).send({ success: false, error: 'Yedek dosya adı belirtilmedi.' });
    }

    try {
      const status = await getBackupStatus();
      const backupItem = status.backups.find((b) => b.filename === filename);
      if (!backupItem) {
        return reply.status(404).send({ success: false, error: 'Belirtilen yedek dosyası bulunamadı.' });
      }

      const result = await restoreBackup(backupItem.fullPath);
      return { success: true, message: result.message };
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
};
