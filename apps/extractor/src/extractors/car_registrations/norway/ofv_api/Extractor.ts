import axios from 'axios';
import z from 'zod';
import {
  FileData,
  FileOuput,
  MonthDateId,
  MonthExtractor,
} from '../../../../lib';

// Dataset público del CMS de ofv.no, con los gráficos mensuales
// de sus artículos ("studiografer"). Hay datos desde julio de 2026.
const SOURCE_URL =
  'https://rmljhg9t.apicdn.sanity.io/v2021-10-21/data/query/production';

const QUERY = `*[_type == "statistikkSnapshot" && dataset == "studiografer" && group == "personbiler" && periodFrom == $from && asOf == $to] | order(_createdAt asc) { _id, payload }`;

interface IRow {
  name: string;
  count: number;
  share: number;
}

interface IData {
  from: string;
  to: string;
  brands: { total: number; rows: IRow[] };
  models: { total: number; rows: IRow[] };
}

class Extractor extends MonthExtractor {
  constructor() {
    super({
      folders: ['car_registrations', 'countries', 'norway'],
      source: 'ofv_api',
      fileext: 'json',
    });
  }

  async download(dateId: MonthDateId): Promise<Buffer | null> {
    const { year, month } = dateId;
    const mm = month.toString().padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const response = await axios.get(SOURCE_URL, {
      params: {
        query: QUERY,
        $from: JSON.stringify(`${year}-${mm}-01`),
        $to: JSON.stringify(`${year}-${mm}-${lastDay}`),
      },
      timeout: 30000,
    });

    // Un mes puede venir repartido en varios snapshots
    // (ej: uno con marcas y otro con modelos). Me quedo con el último de cada parte.
    const snapshots: { _id: string; payload: string }[] =
      response.data.result;
    const data: Record<string, unknown> = {};
    for (const snapshot of snapshots) {
      const payload = JSON.parse(snapshot.payload);
      for (const [key, value] of Object.entries(payload)) {
        if (value !== null && value !== undefined) {
          data[key] = value;
        }
      }
    }

    if (!data.brands || !data.models) {
      return null;
    }

    return Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  }

  async transform(
    dateId: MonthDateId,
    fileData: FileData
  ): Promise<FileOuput[]> {
    const data: IData = JSON.parse(fileData.data.toString());

    return [
      this.transformRows(
        dateId,
        data.brands.rows,
        'brand',
        'top_30_registrations_by_brand'
      ),
      this.transformRows(
        dateId,
        data.models.rows,
        'model',
        'top_30_registrations_by_model'
      ),
    ];
  }

  async debug() {}

  private transformRows(
    dateId: MonthDateId,
    rows: IRow[],
    field: 'brand' | 'model',
    name: string
  ): FileOuput {
    const Schema = z.object({
      year: z.number().int().min(1900).max(2100),
      month: z.number().int().min(1).max(12),
      [field]: z.preprocess(
        (value) => (value as string).replace(/\s+/g, ' ').trim().toUpperCase(),
        z.string()
      ),
      registrations: z.number().int(),
      market_share: z.preprocess(
        (value) => Math.round((value as number) * 100) / 100,
        z.number()
      ),
    });

    const registrations = rows.map((row) =>
      Schema.parse({
        year: dateId.year,
        month: dateId.month,
        [field]: row.name,
        registrations: row.count,
        market_share: row.share,
      })
    );

    return { name, data: registrations };
  }
}

export default new Extractor();
