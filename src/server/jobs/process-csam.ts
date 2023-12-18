import { isProd } from '~/env/other';
import { createJob } from './job';
import {
  archiveCsamDataForReport,
  getCsamsToArchive,
  getCsamsToRemoveContent,
  getCsamsToReport,
  processCsamReport,
} from '~/server/services/csam.service';

export const sendCsamReportsJob = createJob('send-csam-reports', '30 */1 * * *', async () => {
  const reports = await getCsamsToReport();
  // wait for each process to finish before going to the next
  for (const report of reports) {
    await processCsamReport(report);
  }
});

export const archiveCsamReportDataJob = createJob('send-csam-reports', '0 */1 * * *', async () => {
  const reports = await getCsamsToArchive();
  // wait for each process to finish before going to the next
  for (const report of reports) {
    await archiveCsamDataForReport(report);
  }
});

export const removeContentForCsamReportsJob = createJob(
  'remove-csam-content',
  '45 */1 * * *',
  async () => {
    if (!isProd) return;
    const reports = await getCsamsToRemoveContent();
    // wait for each process to finish before going to the next
    for (const report of reports) {
      // await archiveCsamDataForReport(report);
    }
  }
);
