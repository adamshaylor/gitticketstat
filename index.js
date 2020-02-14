#!/usr/bin/env node

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs').promises;
const path = require('path');
const minimist = require('minimist');
const chalk = require('chalk');
const parseGitNumstat = require('parse-git-numstat');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const packageFile = require('./package.json');

const defaultTicketPattern = '[A-Z]+-\\d+';
const defaultFileName = 'gitticketstat.csv';

const getLog = async (repoPath) => {
  const { stdout, stderr } = await exec(`git -C ${repoPath} log --numstat`);
  if (stderr.length) {
    throw new Error(stderr);
  }
  return stdout;
};

const analyzeCommits = (commits, ticketPattern) => {
  const ticketRegExp = new RegExp(ticketPattern, 'g');

  const commitReducer = (ticketStatAccumulator, commit) => {
    const statReducer = (commitStatAccumulator, stat) => ({
      added: stat.added + commitStatAccumulator.added,
      deleted: stat.deleted + commitStatAccumulator.deleted,
    });

    const shortStat = commit.stat.reduce(statReducer, {
      added: 0,
      deleted: 0,
      total: 0,
    });

    const ticketsMatchedInCommit = commit.message.match(ticketRegExp) || [];
    ticketsMatchedInCommit.forEach((ticket) => {
      const existingTicketStat = ticketStatAccumulator.find(
        // Playing with AirBnB's eslint config in this project yields
        // weird results like this wherein single expressions are
        // expected to be unwrapped from their arrow function body
        // braces but the subsequent one-liner is considered too long.
        // Experimenting with line breaks yields further complaints,
        // this one being resolved by appending an idiosyncratic
        // trailing comma.
        (ticketStat) => ticketStat.ticket === ticket,
      );

      if (existingTicketStat) {
        existingTicketStat.added += shortStat.added;
        existingTicketStat.deleted += shortStat.deleted;
        existingTicketStat.total += shortStat.added + shortStat.deleted;
        existingTicketStat.commits += 1;
      } else {
        ticketStatAccumulator.push({
          ticket,
          added: shortStat.added,
          deleted: shortStat.deleted,
          total: shortStat.added + shortStat.deleted,
          commits: 1,
        });
      }
    });

    return ticketStatAccumulator;
  };

  return commits.reduce(commitReducer, []);
};

const resolveOutputPath = async (userOutputPath) => {
  try {
    const userPathStat = await fs.stat(userOutputPath);
    const isDirectory = userPathStat.isDirectory();
    return isDirectory
      ? path.join(userOutputPath, defaultFileName)
      : userOutputPath;
  } catch (error) {
    // Assume that the error is a result of trying to run stat on a
    // file that doesn't exist yet. If this assumption is false, we can
    // safely assume another error will be thrown when attempting to
    // write to userOutputPath.
    return userOutputPath;
  }
};

const saveStatisticsAsCsv = async (statistics, outputPath) => {
  const csvWriter = createCsvWriter({
    path: outputPath,
    header: [
      { id: 'ticket', title: 'Ticket' },
      { id: 'added', title: 'Added' },
      { id: 'deleted', title: 'Deleted' },
      { id: 'total', title: 'Total' },
      { id: 'commits', title: 'Commits' },
    ],
  });

  await csvWriter.writeRecords(statistics);
};

const run = async () => {
  const requiredArgNames = [
    'repoPath',
    'outputPath',
  ];

  const optionalArgNames = [
    'version',
    'ticket-pattern',
  ];

  const argv = minimist(process.argv.slice(2));

  if (argv.v || argv.version) {
    console.log(packageFile.version);
    return;
  }

  if (argv.h || argv.help || argv._.length !== requiredArgNames.length) {
    const optionals = optionalArgNames.map((name) => `[--${name}]`);
    const requireds = requiredArgNames.map((name) => chalk.underline(name));
    console.log();
    console.log(`usage: gitticketstat ${requireds.join(' ')}`);
    console.log(`       ${optionals.join(' ')}\n`);
    return;
  }

  const requiredArgsObj = requiredArgNames.reduce((accumulator, name, index) => {
    accumulator[name] = argv._[index];
    return accumulator;
  }, {});

  try {
    const gitLog = await getLog(requiredArgsObj.repoPath);
    const commits = parseGitNumstat(gitLog);
    const ticketPattern = argv['ticket-pattern'] || defaultTicketPattern;
    const statistics = analyzeCommits(commits, ticketPattern);
    const outputPath = await resolveOutputPath(requiredArgsObj.outputPath);
    await saveStatisticsAsCsv(statistics, outputPath);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

run();
