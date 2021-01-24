// Run with: node scrape.js 1/20/21

const chrome = require('chrome-cookies-secure')
const createCsvWriter = require('csv-writer').createObjectCsvWriter
const csv = require('csv-parser')
const dateFormat = require("dateformat")
const fs = require('fs')
const puppeteer = require('puppeteer')
const stringSimilarity = require("string-similarity");
const stripBom = require('strip-bom-stream');

const ROSTER_FILE = 'Roster.csv'
const SCORES_FILE = 'Scores.csv'
const TIMEOUT_MS = 10000
const URL = 'https://teacher.desmos.com/history'

let DATE = new Date()
DATE.setDate(DATE.getDate() - 1);  // Yesterday
if (process.argv.length > 2) {
  try {
    DATE = new Date(process.argv[2])
  } catch {
    console.log('Failed to parse date:', process.argv[2])
  }
}

async function getCookies(url) {
  return new Promise((resolve, reject) => {
    chrome.getCookies(url, 'puppeteer', function (err, cookies) {
      if (err) reject(err)
      else resolve(cookies)
    })
  })
}

async function getText(elem, selector) {
  const childElem = await elem.$(selector)
  if (!childElem) return ""
  const handle = await childElem.evaluateHandle(el => el.textContent)
  const result = await handle.jsonValue()
  handle.dispose()
  return result
}

async function scrapeDashboard(dashboard, activityName, block) {
  let results = {}
  const students = await dashboard.$$('div.student-grid-row')
  for (let i in students) {
    const student = students[i]
    const name = await getText(student, 'span.grid-student-name')
    const questions = await student.$$('div.grid-cell')
    const incorrect = await student.$$('div.incorrect-decorator')
    const incomplete = await student.$$('div.no-student-work')
    results[name] = {
      completed: questions.length - incomplete.length,
      incorrect: incorrect.length,
      total: questions.length,
      name: activityName,
      block: block,
    }
  }
  return results
}

async function openDashboard(browser, activity, activityName, block) {
  const newPagePromise = new Promise(resolve => // set up promise that will resolve to new dashboard tab
    browser.once('targetcreated', target => resolve(target.page())))
  await activity.click({ button: 'middle' })  // link dashboard in a new tab
  const dashboard = await newPagePromise  // wait for a reference to the new tab
  await Promise.all([ // wait for the dashboard to load
    dashboard.bringToFront(),
    dashboard.setViewport({ 'width': 1024, 'height': 724 }),
    dashboard.waitForNavigation({
      timeout: TIMEOUT_MS,
      waitUntil: 'networkidle2'
    }),
  ])
  const results = await scrapeDashboard(dashboard, activityName, block)
  await dashboard.close()
  return results
}

async function scrapeActivities() {
  process.stdout.write(`Loading assignments since ${dateFormat(DATE, 'm/dd/yy')}`)

  const browser = await puppeteer.launch({
    headless: true  // set to false to watch the browser
  })
  const page = await browser.newPage()
  try {
    const cookies = await getCookies(URL)
    if (!cookies || !cookies.length) {
      console.log("You need to sign into your Desmos account in Chrome.")
      process.exit(1);
    }
    await page.setCookie(...cookies)
  } catch (e) {
    console.log(e)
    process.exit(1);
  }
  await page.setViewport({ 'width': 1024, 'height': 724 });
  await page.goto(URL, { waitUntil: 'networkidle2' });

  // Check to make sure we are on the right page
  if (page.url() !== URL) {
    console.log("You need to sign into your Desmos account in Chrome.")
    process.exit(1);
  }

  // Load all activities
  while (true) {
    const activities = await page.$$('div.history-row-container > a');
    const lastActivity = activities[activities.length - 1]
    const dateString = await getText(lastActivity, 'div.date')
    if (DATE > new Date(dateString)) break  // we've got back far enough
    const loadMore = await page.$('div.load-more-history')
    if (!loadMore) break  // all activities loaded
    try {
      await loadMore.click()
      await page.waitForTimeout(500)
    } catch (e) {
      // can't click "Load More", so assume all are loaded
      break
    }
  }

  // Iterate through the dashboards
  let resultsList = []
  const activities = await page.$$('div.history-row-container > a');
  for (let a in activities) {
    process.stdout.write('.')
    const activity = activities[a];
    const title = await getText(activity, 'div.instance-title')
    const block = await getText(activity, 'div.block-name')
    const date = new Date(await getText(activity, 'div.date'))
    const activityName = `Math - ${title} - due ${dateFormat(date, 'm/dd')}`

    if (DATE > date) break // we've gone back far enough

    const results = await openDashboard(browser, activity, activityName, block)
    resultsList.push(results)
  }
  process.stdout.write('\n')
  browser.close()
  return resultsList
}

async function readRoster() {
  const results = [];
  return new Promise(resolve =>
    fs.createReadStream(ROSTER_FILE)
      .pipe(stripBom())
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
  )
}

function normalize(roster, assignments) {
  // Stage 1: Consolidate scores by student
  const assignmentsByStudent = {}
  for (let i in assignments) {
    const assignment = assignments[i]
    for (let name in assignment) {
      const data = assignment[name]
      const list = assignmentsByStudent[name]
      if (list) list.push(data)
      else assignmentsByStudent[name] = [ data ]
    }
  }

  // Stage 2: Add name to roster
  for (let i in roster) {
    const student = roster[i]
    const firstName = student['First Name']
    const lastName = student['Last Name']
    student.name = `${lastName}, ${firstName}`
  }

  // Stage 3: Map student roster names to assignment names
  const rosterToAssignmentNameMap = {}
  const assignmentNames = Object.keys(assignmentsByStudent)
  const matchedAssignmentNames = []
  let students = roster
  let unmatchedAssignmentNames = assignmentNames
  for (threshold = .9; threshold >= .1; threshold -= .2) {
    const unmatchedStudents = []
    for (let i in students) {
      const student = students[i]
      const match = stringSimilarity.findBestMatch(student.name, unmatchedAssignmentNames).bestMatch
      if (match.rating < threshold) {
        unmatchedStudents.push(student)
        continue
      }
      if (matchedAssignmentNames.includes(match.target)) {
        console.log(stringSimilarity.findBestMatch(student.name, assignmentNames))
        console.log(rosterToAssignmentNameMap)
        console.log(`Duplicate use of ${match.target} ... this is really bad!!!`)
        process.exit(2)
      }
      matchedAssignmentNames.push(match.target)
      rosterToAssignmentNameMap[student.name] = match.target
    }
    unmatchedAssignmentNames = assignmentNames.filter(x => !matchedAssignmentNames.includes(x));
    students = unmatchedStudents
  }
  console.log('Unmatched students:', unmatchedAssignmentNames, '\n')

  // Stage 4: Map assignments to students by roster name / ID
  const assignmentsByRoster = []
  const assignmentTitles = []
  for (let i in roster) {
    const student = roster[i]
    const name = student.name
    const threshold = student['2 pts']
    const assignmentName = rosterToAssignmentNameMap[name]
    const entry = {
      'Unique User ID': student['Unique User ID'],
      name: name,
    }

    const assignments = assignmentsByStudent[assignmentName]
    for (let j in assignments) {
      const assignment = assignments[j]
      if (!assignmentTitles.includes(assignment.name)) assignmentTitles.push(assignment.name)
      let score = 0
      if (assignment.completed > 0) {
        score = (assignment.completed / assignment.total < threshold / 100) ? 1 : 2
      }
      entry[assignment.name] = score
      if (assignment.incorrect >= 4) {
        console.log(`${name} / ${assignment.name}: ${assignment.incorrect} incorrect`)
      }
    }
    assignmentsByRoster.push(entry)
  }
  return {
    titles: assignmentTitles,
    scores: assignmentsByRoster
  }
}

async function run() {
  const roster = await readRoster()
  const assignments = await scrapeActivities()
  if (!assignments || !assignments.length) {
    console.log('No assignments!')
    return
  }

  const {titles, scores} = normalize(roster, assignments)

  // Write scores to CSV file
  const headers = [
    {id: 'Unique User ID', title: 'Unique User ID' },
    {id: 'name', title: 'Name' },
  ].concat(
    titles.map(x => {return { id: x, title: x }}))
  const csvWriter = createCsvWriter({
      header: headers,
      path: SCORES_FILE
    })
  await csvWriter.writeRecords(scores)
  console.log(`\nScores written to: ${SCORES_FILE}`)
}

run()
