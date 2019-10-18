#!/usr/bin/env python3

import logging
import python_sealog
from python_sealog.lowerings import getLoweringIdsByCruise

# Default logging level
LOG_LEVEL = logging.INFO

# create logger
logger = logging.getLogger(__file__)
logger.setLevel(LOG_LEVEL)

# create console handler and set level to debug
ch = logging.StreamHandler()
ch.setLevel(LOG_LEVEL)

# create formatter
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# add formatter to ch
ch.setFormatter(formatter)

# add ch to logger
logger.addHandler(ch)

if __name__ == '__main__':

  import argparse

  parser = argparse.ArgumentParser(description='Retrieve Lowering UID from Lowering ID')
  parser.add_argument('-d', '--debug', action='store_true', help=' display debug messages')
  parser.add_argument('cruise_id', help='Lowering ID i.e. "AT42-01".')

  args = parser.parse_args()

  # Turn on debug mode
  if args.debug:
    logger.info("Setting log level to DEBUG")
    logger.setLevel(logging.DEBUG)
    for handler in logger.handlers:
      handler.setLevel(logging.DEBUG)
    logger.debug("Log level now set to DEBUG")

  lowerings = getLoweringIdsByCruise(args.cruise_id)
  if not lowerings == None:
    print(' '.join(lowerings))
  else:
    logger.error("No lowerings found for cruise_id: " + args.cruise_id)