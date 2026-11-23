import axios from 'axios';
import * as cheerio from 'cheerio';
import xlsx, { CellObject } from 'xlsx';
import z from 'zod';
import {
  FileData,
  FileOuput,
  MonthDateId,
  MonthExtractor,
} from '../../../../lib';

const SOURCE_URL = 'https://www.auto.swiss/';

interface IRow {
  brand: string;
  model: string;
  ytd_registrations: number;
}

class Extractor extends MonthExtractor {
  constructor() {
    super({
      folders: ['car_registrations', 'countries', 'switzerland'],
      source: 'autoswiss',
      fileext: 'xlsx',
    });
  }

  async download(dateId: MonthDateId): Promise<Buffer | null> {
    const { year } = dateId;

    // En la pestaña de modelos hay un excel por año:
    // "Laufendes Jahr (Excel)" para el año en curso
    // y un link con el número del año para los anteriores
    const response = await axios.get(SOURCE_URL);
    const $ = cheerio.load(response.data);
    const links = Array.from($('#tab-2 a')).map((a) => ({
      text: $(a).text().trim(),
      href: $(a).attr('href'),
    }));

    let link = links.find((l) => l.text === `${year}`)?.href;
    if (!link) {
      // El excel del año en curso tiene el año en el nombre
      const current = links.find((l) => l.text.startsWith('Laufendes Jahr'));
      if (current?.href?.includes(`${year}`)) {
        link = current.href;
      }
    }

    // Informo que no hay datos publicados
    if (!link) {
      return null;
    }

    // Descargo el archivo en memoria
    const fileContent = await axios(new URL(link, SOURCE_URL).href, {
      responseType: 'arraybuffer',
    });

    // Valido que los datos del mes estén publicados
    const rows = await this.getTableData(dateId, {
      path: '',
      data: fileContent.data,
    });
    // Informo que no hay datos publicados
    if (rows.length === 0) {
      return null;
    }

    return fileContent.data;
  }

  async transform(
    dateId: MonthDateId,
    fileData: FileData
  ): Promise<FileOuput[]> {
    const { year, month } = dateId;
    const rows = await this.getTableData(dateId, fileData);

    // Valido la data con zod
    // Valido con zod
    const Schema = z
      .object({
        year: z.number(),
        month: z.number(),
        brand: z.string().trim().toUpperCase(),
        model: z.string().trim().toUpperCase(),
        ytd_registrations: z.number().int(),
      })
      .strict();

    type IRegistrations = z.infer<typeof Schema>;
    const registrations: IRegistrations[] = [];
    for (const row of rows) {
      const parsed = Schema.parse({
        year,
        month,
        ...row,
      });
      registrations.push(parsed);
    }

    return [
      {
        name: 'ytd_registrations_by_model',
        data: registrations,
      },
    ];
  }

  async debug() {}

  private async getTableData(
    dateId: MonthDateId,
    fileData: FileData
  ): Promise<IRow[]> {
    const { month } = dateId;
    const workbook = xlsx.read(fileData.data, { type: 'buffer' });

    // Me quedo con la página que coincide con el mes
    const MONTH_MAP = {
      1: 'Jan',
      2: 'Febr',
      3: 'Mrz',
      4: 'Apr',
      5: 'Mai',
      6: 'Juni',
      7: 'Juli',
      8: 'Aug',
      9: 'Sept',
      10: 'Okt',
      11: 'Nov',
      12: 'Dez',
    };
    const sheetName = MONTH_MAP[month];

    const sheet = workbook.Sheets[sheetName];
    let cells: { key: string; data: CellObject }[] = Object.keys(sheet).map(
      (key) => ({ key, data: sheet[key] })
    );

    // Me con el contenido de la tabla
    const startPos = cells.findIndex((cell) => cell.data.w === 'Anzahl');
    const endPos = cells.findIndex((cell) => cell.data.w === 'Total');
    cells = cells.slice(startPos + 4, endPos);

    // Extraigo la información de la tabla
    const raw: IRow[] = [];
    for (let i = 0; i < cells.length; i += 6) {
      const brand = cells[i].data.w;
      const model = cells[i + 1].data.w;
      const ytd_registrations = cells[i + 2].data.v as number;

      raw.push({ brand, model, ytd_registrations });
    }

    // Elimino el último elemento que es el total
    raw.pop();

    return raw;
  }
}

export default new Extractor();
