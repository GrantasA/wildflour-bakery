<?php
/**
 * Pure opening-hours logic: no WordPress dependencies, fully unit-testable.
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

/**
 * Evaluates a weekly schedule plus date exceptions in a location's own timezone.
 *
 * A schedule is an associative array keyed by lowercase three-letter day:
 *   array( 'mon' => array( array( 'open' => '08:00', 'close' => '17:00' ) ), ... )
 *
 * A period whose close time is less than or equal to its open time is treated as
 * running past midnight into the following day (e.g. 22:00-02:00).
 *
 * Exceptions are keyed by 'Y-m-d' for one-off dates or 'm-d' for dates that
 * repeat every year. An empty period list means "closed all day".
 */
class LBSH_Schedule {

	const DAYS = array( 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun' );

	/**
	 * Weekly recurring hours.
	 *
	 * @var array
	 */
	private $weekly;

	/**
	 * Date-keyed overrides.
	 *
	 * @var array
	 */
	private $exceptions;

	/**
	 * Location timezone.
	 *
	 * @var DateTimeZone
	 */
	private $timezone;

	/**
	 * Constructor.
	 *
	 * @param array  $weekly     Weekly hours keyed by day.
	 * @param array  $exceptions Date overrides keyed by 'Y-m-d' or 'm-d'.
	 * @param string $timezone   PHP timezone identifier.
	 */
	public function __construct( array $weekly, array $exceptions = array(), $timezone = 'UTC' ) {
		$this->weekly     = self::normalize_weekly( $weekly );
		$this->exceptions = $exceptions;

		try {
			$this->timezone = new DateTimeZone( $timezone );
		} catch ( Exception $e ) {
			$this->timezone = new DateTimeZone( 'UTC' );
		}
	}

	/**
	 * Fill in missing days and drop malformed periods.
	 *
	 * @param array $weekly Raw weekly hours.
	 * @return array
	 */
	public static function normalize_weekly( array $weekly ) {
		$out = array();

		foreach ( self::DAYS as $day ) {
			$out[ $day ] = array();

			if ( empty( $weekly[ $day ] ) || ! is_array( $weekly[ $day ] ) ) {
				continue;
			}

			foreach ( $weekly[ $day ] as $period ) {
				$normalized = self::normalize_period( $period );

				if ( null !== $normalized ) {
					$out[ $day ][] = $normalized;
				}
			}

			usort(
				$out[ $day ],
				static function ( $a, $b ) {
					return strcmp( $a['open'], $b['open'] );
				}
			);
		}

		return $out;
	}

	/**
	 * Validate a single open/close pair.
	 *
	 * @param mixed $period Candidate period.
	 * @return array|null Normalized period, or null when invalid.
	 */
	private static function normalize_period( $period ) {
		if ( ! is_array( $period ) || ! isset( $period['open'], $period['close'] ) ) {
			return null;
		}

		$open  = self::normalize_time( $period['open'] );
		$close = self::normalize_time( $period['close'] );

		if ( null === $open || null === $close ) {
			return null;
		}

		return array(
			'open'  => $open,
			'close' => $close,
		);
	}

	/**
	 * Coerce a time string to strict 'H:i'.
	 *
	 * @param mixed $value Candidate time.
	 * @return string|null
	 */
	public static function normalize_time( $value ) {
		if ( ! is_string( $value ) || ! preg_match( '/^(\d{1,2}):(\d{2})$/', trim( $value ), $m ) ) {
			return null;
		}

		$hours   = (int) $m[1];
		$minutes = (int) $m[2];

		if ( $hours > 24 || $minutes > 59 ) {
			return null;
		}

		return sprintf( '%02d:%02d', $hours, $minutes );
	}

	/**
	 * Whether a period runs past midnight.
	 *
	 * @param array $period Normalized period.
	 * @return bool
	 */
	private static function is_overnight( array $period ) {
		return $period['close'] <= $period['open'];
	}

	/**
	 * The exception entry that applies to a given date, if any.
	 *
	 * An exact 'Y-m-d' match wins over an annually repeating 'm-d' match.
	 *
	 * @param DateTimeInterface $date Date to look up.
	 * @return array|null List of periods (possibly empty), or null when no exception applies.
	 */
	public function exception_for( DateTimeInterface $date ) {
		$exact = $date->format( 'Y-m-d' );

		if ( array_key_exists( $exact, $this->exceptions ) ) {
			return self::normalize_weekly( array( 'mon' => (array) $this->exceptions[ $exact ] ) )['mon'];
		}

		$annual = $date->format( 'm-d' );

		if ( array_key_exists( $annual, $this->exceptions ) ) {
			return self::normalize_weekly( array( 'mon' => (array) $this->exceptions[ $annual ] ) )['mon'];
		}

		return null;
	}

	/**
	 * Effective periods for a calendar date, applying exceptions.
	 *
	 * @param DateTimeInterface $date Date to resolve.
	 * @return array List of normalized periods.
	 */
	public function periods_on( DateTimeInterface $date ) {
		$exception = $this->exception_for( $date );

		if ( null !== $exception ) {
			return $exception;
		}

		$day = strtolower( $date->format( 'D' ) );

		return isset( $this->weekly[ $day ] ) ? $this->weekly[ $day ] : array();
	}

	/**
	 * Build a concrete open/close instant pair for a period on a date.
	 *
	 * @param DateTimeImmutable $date   Date the period starts on.
	 * @param array             $period Normalized period.
	 * @return array{0:DateTimeImmutable,1:DateTimeImmutable}
	 */
	private function materialize( DateTimeImmutable $date, array $period ) {
		$start = $this->at( $date, $period['open'] );
		$end   = $this->at( $date, $period['close'] );

		if ( self::is_overnight( $period ) ) {
			$end = $this->at( $date->modify( '+1 day' ), $period['close'] );
		}

		return array( $start, $end );
	}

	/**
	 * Combine a date and a wall-clock time in the location timezone.
	 *
	 * '24:00' is normalized to midnight on the following day.
	 *
	 * @param DateTimeImmutable $date Date part.
	 * @param string            $time Time part as 'H:i'.
	 * @return DateTimeImmutable
	 */
	private function at( DateTimeImmutable $date, $time ) {
		if ( '24:00' === $time ) {
			return $date->modify( '+1 day' )->setTime( 0, 0 );
		}

		list( $hours, $minutes ) = array_map( 'intval', explode( ':', $time ) );

		return $date->setTime( $hours, $minutes );
	}

	/**
	 * Every opening interval that could cover the given moment.
	 *
	 * Includes the previous day so overnight periods are considered.
	 *
	 * @param DateTimeImmutable $moment Reference moment.
	 * @return array List of [start, end] pairs, ordered by start.
	 */
	private function intervals_around( DateTimeImmutable $moment ) {
		$intervals = array();
		$day       = $moment->setTime( 0, 0 )->modify( '-1 day' );

		for ( $i = 0; $i < 2; $i++ ) {
			foreach ( $this->periods_on( $day ) as $period ) {
				$intervals[] = $this->materialize( $day, $period );
			}

			$day = $day->modify( '+1 day' );
		}

		return $intervals;
	}

	/**
	 * Whether the location is open at a given moment.
	 *
	 * @param DateTimeInterface|null $moment Moment to test, defaults to now.
	 * @return bool
	 */
	public function is_open( DateTimeInterface $moment = null ) {
		return null !== $this->current_interval( $moment );
	}

	/**
	 * The opening interval covering a moment, if any.
	 *
	 * The interval is half-open: the closing instant itself counts as closed.
	 *
	 * @param DateTimeInterface|null $moment Moment to test, defaults to now.
	 * @return array|null [start, end] pair or null.
	 */
	public function current_interval( DateTimeInterface $moment = null ) {
		$now = $this->localize( $moment );

		foreach ( $this->intervals_around( $now ) as $interval ) {
			if ( $now >= $interval[0] && $now < $interval[1] ) {
				return $interval;
			}
		}

		return null;
	}

	/**
	 * The next moment the open/closed state changes.
	 *
	 * @param DateTimeInterface|null $moment    Reference moment, defaults to now.
	 * @param int                    $max_days  How far ahead to scan.
	 * @return array{state:string,at:DateTimeImmutable}|null Null when nothing changes within the window.
	 */
	public function next_change( DateTimeInterface $moment = null, $max_days = 14 ) {
		$now     = $this->localize( $moment );
		$current = $this->current_interval( $now );

		if ( null !== $current ) {
			return array(
				'state' => 'closes',
				'at'    => $current[1],
			);
		}

		$day = $now->setTime( 0, 0 );

		for ( $i = 0; $i <= $max_days; $i++ ) {
			$starts = array();

			foreach ( $this->periods_on( $day ) as $period ) {
				list( $start ) = $this->materialize( $day, $period );

				if ( $start > $now ) {
					$starts[] = $start;
				}
			}

			if ( ! empty( $starts ) ) {
				sort( $starts );

				return array(
					'state' => 'opens',
					'at'    => $starts[0],
				);
			}

			$day = $day->modify( '+1 day' );
		}

		return null;
	}

	/**
	 * Convert any moment into this schedule's timezone.
	 *
	 * @param DateTimeInterface|null $moment Moment to convert.
	 * @return DateTimeImmutable
	 */
	private function localize( DateTimeInterface $moment = null ) {
		if ( null === $moment ) {
			return new DateTimeImmutable( 'now', $this->timezone );
		}

		$immutable = $moment instanceof DateTimeImmutable
			? $moment
			: DateTimeImmutable::createFromFormat( 'U', $moment->format( 'U' ) );

		return $immutable->setTimezone( $this->timezone );
	}

	/**
	 * Weekly hours in schema.org openingHours short form, one entry per period.
	 *
	 * Consecutive days sharing identical hours are grouped (e.g. "Mo-Fr 09:00-17:00").
	 *
	 * @return array List of strings.
	 */
	public function to_opening_hours_strings() {
		$labels = array(
			'mon' => 'Mo',
			'tue' => 'Tu',
			'wed' => 'We',
			'thu' => 'Th',
			'fri' => 'Fr',
			'sat' => 'Sa',
			'sun' => 'Su',
		);

		$out   = array();
		$index = 0;

		while ( $index < count( self::DAYS ) ) {
			$day     = self::DAYS[ $index ];
			$periods = $this->weekly[ $day ];

			if ( empty( $periods ) ) {
				$index++;
				continue;
			}

			$last = $index;

			while ( $last + 1 < count( self::DAYS )
				&& $this->weekly[ self::DAYS[ $last + 1 ] ] === $periods ) {
				$last++;
			}

			$range = $last > $index
				? $labels[ $day ] . '-' . $labels[ self::DAYS[ $last ] ]
				: $labels[ $day ];

			foreach ( $periods as $period ) {
				$out[] = $range . ' ' . $period['open'] . '-' . $period['close'];
			}

			$index = $last + 1;
		}

		return $out;
	}

	/**
	 * Weekly hours as schema.org OpeningHoursSpecification nodes.
	 *
	 * @return array
	 */
	public function to_opening_hours_specification() {
		$names = array(
			'mon' => 'Monday',
			'tue' => 'Tuesday',
			'wed' => 'Wednesday',
			'thu' => 'Thursday',
			'fri' => 'Friday',
			'sat' => 'Saturday',
			'sun' => 'Sunday',
		);

		$out = array();

		foreach ( self::DAYS as $day ) {
			foreach ( $this->weekly[ $day ] as $period ) {
				$out[] = array(
					'@type'     => 'OpeningHoursSpecification',
					'dayOfWeek' => 'https://schema.org/' . $names[ $day ],
					'opens'     => $period['open'],
					'closes'    => $period['close'],
				);
			}
		}

		return $out;
	}

	/**
	 * Normalized weekly hours.
	 *
	 * @return array
	 */
	public function weekly() {
		return $this->weekly;
	}

	/**
	 * Raw date exceptions.
	 *
	 * @return array
	 */
	public function exceptions() {
		return $this->exceptions;
	}

	/**
	 * Schedule timezone.
	 *
	 * @return DateTimeZone
	 */
	public function timezone() {
		return $this->timezone;
	}
}
