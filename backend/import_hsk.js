import XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'database.json');

const files = [
  { level: 1, path: 'c:\\Users\\BRAVO 15\\Downloads\\webtiengtrung\\filetuvung\\TỔNG HỢP TỪ VỰNG HSK 1 PHIÊN BẢN 3.0.xlsx' },
  { level: 2, path: 'c:\\Users\\BRAVO 15\\Downloads\\webtiengtrung\\filetuvung\\TỔNG HỢP TỪ VỰNG HSK 2 PHIÊN BẢN 3.0.xlsx' },
  { level: 3, path: 'c:\\Users\\BRAVO 15\\Downloads\\webtiengtrung\\filetuvung\\TỔNG HỢP TỪ VỰNG HSK 3 PHIÊN BẢN 3.0.xlsx' },
  { level: 4, path: 'c:\\Users\\BRAVO 15\\Downloads\\webtiengtrung\\filetuvung\\TỔNG HỢP TỪ VỰNG HSK 4 PHIÊN BẢN 3.0.xlsx' },
  { level: 5, path: 'c:\\Users\\BRAVO 15\\Downloads\\webtiengtrung\\filetuvung\\TỔNG HỢP TỪ VỰNG HSK 5 PHIÊN BẢN 3.0.xlsx' },
  { level: 6, path: 'c:\\Users\\BRAVO 15\\Downloads\\webtiengtrung\\filetuvung\\TỔNG HỢP TỪ VỰNG HSK 6 PHIÊN BẢN 3.0.xlsx' }
];

// Helper to clean up pinyin by removing starting and trailing slashes
function cleanPinyin(pinyin) {
  if (!pinyin) return '';
  // Remove slash symbols
  return pinyin.toString().replace(/^\/|\/$/g, '').trim();
}

async function run() {
  console.log('Starting HSK vocabulary import...');

  // 1. Read existing database.json to preserve user state and custom words
  let customWords = [];
  const existingStatusMap = new Map(); // key: word_level -> { isMemorized, isStarred }

  try {
    const dbContent = await fs.readFile(DB_PATH, 'utf-8');
    const existingList = JSON.parse(dbContent);

    existingList.forEach(item => {
      if (item.isCustom) {
        customWords.push(item);
      } else {
        const key = `${item.word.trim()}_hsk${item.level}`;
        existingStatusMap.set(key, {
          isMemorized: !!item.isMemorized,
          isStarred: !!item.isStarred
        });
      }
    });
    console.log(`Loaded existing DB. Preserved custom words: ${customWords.length}. Map status count: ${existingStatusMap.size}`);
  } catch (err) {
    console.warn('Could not read existing database.json or it is empty. Starting fresh.', err.message);
  }

  // 2. Parse vocabulary from Excel files
  const importedList = [];
  let currentId = 1;

  for (const f of files) {
    console.log(`\nParsing Level ${f.level} from file: ${path.basename(f.path)}`);
    try {
      const workbook = XLSX.readFile(f.path);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      let headerIdx = -1;
      // Search for the header row
      for (let i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i][0] === 'STT') {
          headerIdx = i;
          break;
        }
      }

      if (headerIdx === -1) {
        console.error(`Could not find header row (starting with 'STT') in Level ${f.level} file!`);
        continue;
      }

      let lastWord = '';
      let lastPinyin = '';
      let fileItemCount = 0;

      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const sttValue = row[0];
        let wordVal = row[1];
        let pinyinVal = row[2];
        const categoryVal = row[3];
        const meaningVal = row[4];
        const exampleZhVal = row[5];
        const exampleViVal = row[7];

        let isSubMeaning = false;
        let isNewWord = false;

        // If stt is a number, it starts a new word
        if (sttValue && !isNaN(parseInt(sttValue.toString().trim()))) {
          isNewWord = true;
        } else if (!sttValue && (categoryVal || meaningVal)) {
          // If stt is empty, but there is category or meaning, it is a sub-meaning
          isSubMeaning = true;
        }

        if (isNewWord) {
          lastWord = (wordVal || '').toString().trim();
          lastPinyin = cleanPinyin(pinyinVal);
          
          if (!lastWord) continue; // Skip divider rows with STT but no word
        } else if (isSubMeaning) {
          wordVal = lastWord;
          pinyinVal = lastPinyin;
        } else {
          // Skip other rows (like PHẦN 1, empty rows, header notes)
          continue;
        }

        const word = (wordVal || lastWord).toString().trim();
        const pinyin = isSubMeaning ? lastPinyin : cleanPinyin(pinyinVal || lastPinyin);
        const category = (categoryVal || 'Chưa phân loại').toString().trim();
        const meaning = (meaningVal || '').toString().trim();
        const example_zh = (exampleZhVal || '').toString().trim();
        const example_vi = (exampleViVal || '').toString().trim();

        if (!word) continue;

        // Check if there is existing user status to preserve
        const statusKey = `${word}_hsk${f.level}`;
        let isMemorized = false;
        let isStarred = false;

        if (existingStatusMap.has(statusKey)) {
          const status = existingStatusMap.get(statusKey);
          isMemorized = status.isMemorized;
          isStarred = status.isStarred;
        }

        importedList.push({
          id: currentId++,
          word,
          pinyin,
          meaning,
          level: f.level,
          category,
          example_zh,
          example_vi,
          isMemorized,
          isStarred,
          isCustom: false
        });

        fileItemCount++;
      }

      console.log(`Successfully parsed ${fileItemCount} items for Level ${f.level}.`);
    } catch (err) {
      console.error(`Error processing Level ${f.level}:`, err);
    }
  }

  // 3. Append custom words at the end of database list with updated IDs
  console.log(`\nImported built-in words: ${importedList.length}`);
  console.log(`Appending custom words: ${customWords.length}`);

  customWords.forEach(customItem => {
    importedList.push({
      ...customItem,
      id: currentId++
    });
  });

  // 4. Write back to database.json
  try {
    await fs.writeFile(DB_PATH, JSON.stringify(importedList, null, 2), 'utf-8');
    console.log(`\nSuccessfully wrote ${importedList.length} total items to database.json!`);
  } catch (err) {
    console.error('Failed to save imported vocabulary list to database.json:', err);
  }
}

run();
