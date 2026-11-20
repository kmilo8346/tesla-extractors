import axios from 'axios';
import * as cheerio from 'cheerio';
import PDFParser, { Output, Text } from 'pdf2json';
import z from 'zod';
import {
  FileData,
  FileOuput,
  MonthDateId,
  MonthExtractor,
} from '../../../../lib';

const SOURCE_URL = 'https://www.car-importers.org.il/Rishuy_en/private';
const PREVIOUS_YEARS_URL =
  'https://www.car-importers.org.il/Rishuy_en/previous_years_private';

class Extractor extends MonthExtractor {
  constructor() {
    super({
      folders: ['car_registrations', 'countries', 'israel'],
      source: 'car_importers_evs',
      fileext: 'pdf',
    });
  }

  async download(dateId: MonthDateId): Promise<Buffer | null> {
    const { year, month } = dateId;

    const response = await axios.get(SOURCE_URL);
    const $ = cheerio.load(response.data);

    // Encuentro el link a descargar
    const MONTH_MAP = {
      1: 'JANUARY',
      2: 'FEBRUARY',
      3: 'MARCH',
      4: 'APRIL',
      5: 'MAY',
      6: 'JUNE',
      7: 'JULY',
      8: 'AUGUST',
      9: 'SEPTEMBER',
      10: 'OCTOBER',
      11: 'NOVEMBER',
      12: 'DECEMBER',
    };
    const expectedText = `${MONTH_MAP[month]} ${year} - ELECT`;

    let downloadURL: string = null;
    const containers = Array.from($('.one_month'));
    if (containers.length === 0) {
      throw new Error('Unexpected number of containers');
    }

    for (const container of containers) {
      const links = Array.from($(container).find('a'));
      if (links.length !== 2) {
        throw new Error('Unexpected number of links');
      }

      const link = links[1];
      const text = $(link).text().trim().toUpperCase();
      if (text.startsWith(expectedText)) {
        downloadURL = $(link).attr('href');
        break;
      }
    }

    // La página solo lista los meses del año en curso,
    // diciembre del año anterior queda como el archivo anual
    if (downloadURL === null && month === 12) {
      return this.downloadDecember(year);
    }

    // Si no hay link, informo que los datos aún no están publicados
    if (downloadURL === null) {
      return null;
    }

    // Completo la url
    downloadURL = `https://www.car-importers.org.il${downloadURL}`;

    // Descargo el archivo
    const fileContent = await axios(downloadURL, {
      responseType: 'arraybuffer',
    });

    return fileContent.data;
  }

  async downloadDecember(year: number): Promise<Buffer | null> {
    const response = await axios.get(PREVIOUS_YEARS_URL);
    const $ = cheerio.load(response.data);

    const link = Array.from($('.one_month a')).find(
      (a) => $(a).text().trim().toUpperCase() === `ELECTRIFIED VEHICLES ${year}`
    );
    if (!link) {
      return null;
    }

    const fileContent = await axios(
      `https://www.car-importers.org.il${$(link).attr('href')}`,
      { responseType: 'arraybuffer' }
    );

    // Valido que el archivo anual sea hasta el 31 de diciembre
    const pdfJSON = await new Promise<Output>((resolve, reject) => {
      const pdfParser = new PDFParser();
      pdfParser.on('pdfParser_dataError', (errData) =>
        reject(errData.parserError)
      );
      pdfParser.on('pdfParser_dataReady', (pdfData) => resolve(pdfData));
      pdfParser.parseBuffer(Buffer.from(fileContent.data));
    });
    const texts = pdfJSON.Pages[0].Texts.map((text) =>
      decodeURIComponent(text.R[0].T).trim()
    );
    const toDate = texts[texts.indexOf('To:') + 1];
    if (toDate !== `31/12/${year}`) {
      throw new Error(
        `Annual file for ${year} ends on "${toDate}", expected "31/12/${year}"`
      );
    }

    return fileContent.data;
  }

  async transform(
    dateId: MonthDateId,
    fileData: FileData
  ): Promise<FileOuput[]> {
    const { year, month } = dateId;

    // Convierto el pdf a json
    const pdfJSON = await new Promise<Output>((resolve, reject) => {
      const pdfParser = new PDFParser();

      pdfParser.on('pdfParser_dataError', (errData) =>
        reject(errData.parserError)
      );

      pdfParser.on('pdfParser_dataReady', async (pdfData) => {
        resolve(pdfData);
      });

      pdfParser.loadPDF(fileData.path);
    });

    // La tabla siempre está en la primera página
    const pages = pdfJSON.Pages;
    if (pages.length !== 1) {
      throw new Error('Unexpected number of pages');
    }

    const texts = pages[0].Texts;

    // Me quedo con las celdas de la tabla, entre el encabezado
    // que parte con "Make" y la fila "Total" del final.
    // Hasta 2025: Make | Electric | Hybrid | Plug In | Diesel Plug In | Total
    // Desde 2026: Make | Electric_2026 | Hybrid_2026 | Plug-In_2026 | Total_2026
    //             | Electric_2025 | Hybrid_2025 | Plug-In_2025 | Total_2025
    // (desde 2026 "Diesel Plug In" viene sumado en "Plug-In")
    const values = texts.map((text) => decodeURIComponent(text.R[0].T).trim());
    const makeIndex = values.indexOf('Make');
    let headerEnd = makeIndex + 1;
    while (/^(Electric|Hybrid|Plug|Diesel|Total)/.test(values[headerEnd])) {
      headerEnd++;
    }
    const header = values.slice(makeIndex + 1, headerEnd);
    const endIndex = values.indexOf('Total', headerEnd);
    if (makeIndex === -1 || header.length === 0 || endIndex === -1) {
      throw new Error('Table start pattern or end pattern not found');
    }
    const cells: Text[] = texts.slice(headerEnd, endIndex);

    // La cantidad de celdas debe ser un múltiplo de las columnas
    // porque no hay celdas en blanco
    const columns = header.length + 1;
    if (cells.length % columns !== 0) {
      throw new Error('Unexpected number of cells');
    }

    // Busco la columna de cada tipo para el año del archivo
    const findColumn = (pattern: RegExp) => {
      const index = header.findIndex((name) => {
        const [, type, columnYear] = name.match(/^(.+?)(?:_(\d{4}))?$/);
        return (
          pattern.test(type) &&
          (columnYear === undefined || parseInt(columnYear, 10) === year)
        );
      });
      return index === -1 ? -1 : index + 1;
    };
    const electricColumn = findColumn(/^Electric$/);
    const hybridColumn = findColumn(/^Hybrid$/);
    const pluginColumn = findColumn(/^Plug[ -]In$/);
    const dieselPluginColumn = findColumn(/^Diesel Plug In$/);
    const totalColumn = findColumn(/^Total$/);
    if (
      [electricColumn, hybridColumn, pluginColumn, totalColumn].includes(-1)
    ) {
      throw new Error(`Unexpected table header: ${header.join(' | ')}`);
    }

    // Valido los datos con zod
    const Schema = z
      .object({
        year: z.number(),
        month: z.number(),
        brand: z
          .string()
          .transform((val) => decodeURIComponent(val).trim().toUpperCase()),
        ytd_electric_registrations: z.preprocess((val: string) => {
          return parseInt(decodeURIComponent(val).replace(/\s/g, ''), 10);
        }, z.number().int()),
        ytd_hybrid_registrations: z.preprocess((val: string) => {
          return parseInt(decodeURIComponent(val).replace(/\s/g, ''), 10);
        }, z.number().int()),
        ytd_plugin_registrations: z.preprocess((val: string) => {
          return parseInt(decodeURIComponent(val).replace(/\s/g, ''), 10);
        }, z.number().int()),
        ytd_diesel_plugin_registrations: z.preprocess((val: string) => {
          return parseInt(decodeURIComponent(val).replace(/\s/g, ''), 10);
        }, z.number().int()),
        ytd_registrations: z.preprocess((val: string) => {
          return parseInt(decodeURIComponent(val).replace(/\s/g, ''), 10);
        }, z.number().int()),
      })
      .strict();
    type Registrations = z.infer<typeof Schema>;

    const registrations: Registrations[] = [];
    for (let i = 0; i < cells.length; i += columns) {
      const parsed = Schema.parse({
        year,
        month,
        brand: cells[i + 0].R[0].T,
        ytd_electric_registrations: cells[i + electricColumn].R[0].T,
        ytd_hybrid_registrations: cells[i + hybridColumn].R[0].T,
        ytd_plugin_registrations: cells[i + pluginColumn].R[0].T,
        ytd_diesel_plugin_registrations:
          dieselPluginColumn === -1
            ? '0'
            : cells[i + dieselPluginColumn].R[0].T,
        ytd_registrations: cells[i + totalColumn].R[0].T,
      });

      registrations.push(parsed);
    }

    return [
      {
        name: 'ytd_registrations_by_brand',
        data: registrations,
      },
    ];
  }

  async debug() {}
}

export default new Extractor();
