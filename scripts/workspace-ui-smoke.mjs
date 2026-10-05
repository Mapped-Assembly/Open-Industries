import {chromium,expect} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
const base=process.env.ASTRA_BASE_URL||'http://127.0.0.1:8787';const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(base);
  await page.locator('input[aria-label="Import files"]').setInputFiles({name:'position.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({hardware_ir_version:'0.2',overview:{title:'Position fixture'},mechanical:{render_dimensions:{x_mm:1000,y_mm:500,z_mm:700}}}))});
  const position=page.getByLabel('Position fixture X position',{exact:true});await position.fill('3');
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(position).toHaveValue('0');
  await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(position).toHaveValue('3');
  await page.getByRole('button',{name:'GIF studio',exact:true}).click();const studio=page.getByRole('region',{name:'GIF studio',exact:true});
  await studio.getByLabel('GIF resolution').selectOption('320');await studio.getByLabel('Duration').selectOption('2');await studio.getByLabel('Export scope').selectOption('section');
  await studio.getByRole('button',{name:'Render GIF',exact:true}).click();await expect(studio.getByRole('alert')).toContainText('no visible assets');
  await position.fill('.5');await studio.getByRole('button',{name:'Render GIF',exact:true}).click();await expect(studio.getByRole('status',{name:'GIF export status'})).toContainText('GIF ready',{timeout:60000});
  const event=page.waitForEvent('download');await studio.getByRole('link',{name:'Download review metadata'}).click();const file=await event;const stream=await file.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);const metadata=JSON.parse(Buffer.concat(chunks));expect(metadata.assets[0].position[0]).toBe(.5);
  await page.getByRole('button',{name:'Close GIF studio'}).click();await page.getByRole('button',{name:'Duplicate',exact:true}).click();await expect(page.locator('.asset')).toHaveCount(2);await page.getByLabel('Position fixture copy X position',{exact:true}).fill('4');expect(Number(await position.inputValue())).toBe(.5);
  const timeline=page.getByRole('region',{name:'Animation timeline'});await timeline.getByRole('button',{name:'Add / update keyframe'}).click();
  await timeline.getByLabel('Keyframe time',{exact:true}).fill('2');await timeline.getByLabel('Keyframe position X',{exact:true}).fill('1.5');await timeline.getByRole('button',{name:'Add / update keyframe'}).click();
  await timeline.getByLabel('Keyframe time',{exact:true}).fill('0');await timeline.getByRole('button',{name:'Play animation'}).click();await expect.poll(async()=>Number(await timeline.getByLabel('Keyframe time',{exact:true}).inputValue())).toBeGreaterThan(.1);await timeline.getByRole('button',{name:'Pause animation'}).click();const paused=await timeline.getByLabel('Keyframe time',{exact:true}).inputValue();await page.waitForTimeout(150);await expect(timeline.getByLabel('Keyframe time',{exact:true})).toHaveValue(paused);
  await timeline.getByRole('button',{name:'Reset to base layout'}).click();expect(Number(await position.inputValue())).toBe(.5);await timeline.getByRole('button',{name:'Delete keyframe at 2 seconds'}).click();await expect(timeline.getByRole('button',{name:'Delete keyframe at 2 seconds'})).toHaveCount(0);
  expect(errors).toEqual([]);console.log('PASS edited section/GIF consistency, undo/redo, independent duplicates, authored playback/pause/reset, and key deletion.');
}finally{await browser.close();}
