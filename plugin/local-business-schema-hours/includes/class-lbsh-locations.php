<?php
/**
 * Storage and sanitization for business locations.
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

/**
 * Reads and writes the location list, and builds schedules from it.
 */
class LBSH_Locations {

	const OPTION = 'lbsh_locations';

	/**
	 * Plain text fields stored per location.
	 *
	 * @var string[]
	 */
	const TEXT_FIELDS = array(
		'name',
		'type',
		'telephone',
		'street',
		'city',
		'region',
		'postcode',
		'country',
		'latitude',
		'longitude',
		'price_range',
		'timezone',
	);

	/**
	 * An empty location with sensible defaults.
	 *
	 * @return array
	 */
	public static function blank() {
		$weekly = array();

		foreach ( LBSH_Schedule::DAYS as $day ) {
			$weekly[ $day ] = array();
		}

		return array(
			'id'          => '',
			'name'        => get_bloginfo( 'name' ),
			'type'        => 'LocalBusiness',
			'url'         => home_url( '/' ),
			'email'       => '',
			'telephone'   => '',
			'description' => '',
			'image'       => '',
			'street'      => '',
			'city'        => '',
			'region'      => '',
			'postcode'    => '',
			'country'     => '',
			'latitude'    => '',
			'longitude'   => '',
			'price_range' => '',
			'sameas'      => '',
			'timezone'    => wp_timezone_string(),
			'weekly'      => $weekly,
			'exceptions'  => array(),
		);
	}

	/**
	 * All configured locations, trimmed to the current licence allowance.
	 *
	 * Locations beyond the free allowance stay in the database but are not
	 * rendered, so downgrading never destroys data.
	 *
	 * @return array List of locations keyed by position.
	 */
	public static function get_all() {
		$stored = get_option( self::OPTION, array() );

		if ( ! is_array( $stored ) || empty( $stored ) ) {
			return array();
		}

		$stored = array_values( $stored );
		$limit  = LBSH_License::location_limit();

		if ( PHP_INT_MAX !== $limit && count( $stored ) > $limit ) {
			$stored = array_slice( $stored, 0, $limit );
		}

		return $stored;
	}

	/**
	 * Every stored location, ignoring the licence allowance.
	 *
	 * @return array
	 */
	public static function get_all_raw() {
		$stored = get_option( self::OPTION, array() );

		return is_array( $stored ) ? array_values( $stored ) : array();
	}

	/**
	 * A single location by its identifier.
	 *
	 * @param string $id Location identifier.
	 * @return array|null
	 */
	public static function get( $id ) {
		foreach ( self::get_all() as $location ) {
			if ( (string) $id === (string) $location['id'] ) {
				return $location;
			}
		}

		return null;
	}

	/**
	 * The first configured location, used when no identifier is given.
	 *
	 * @return array|null
	 */
	public static function primary() {
		$all = self::get_all();

		return empty( $all ) ? null : $all[0];
	}

	/**
	 * Build a schedule object for a location.
	 *
	 * Exceptions are a premium feature, so the free edition evaluates weekly
	 * hours only even if exception data is present from a previous licence.
	 *
	 * @param array $location Location data.
	 * @return LBSH_Schedule
	 */
	public static function schedule( array $location ) {
		$exceptions = LBSH_License::is_pro() && ! empty( $location['exceptions'] )
			? (array) $location['exceptions']
			: array();

		$timezone = ! empty( $location['timezone'] ) ? $location['timezone'] : wp_timezone_string();

		return new LBSH_Schedule( (array) $location['weekly'], $exceptions, $timezone );
	}

	/**
	 * Replace the stored location list.
	 *
	 * @param array $locations Sanitized locations.
	 * @return void
	 */
	public static function save( array $locations ) {
		update_option( self::OPTION, array_values( $locations ), false );
	}

	/**
	 * Sanitize a raw submitted location list.
	 *
	 * @param array $raw Untrusted input.
	 * @return array
	 */
	public static function sanitize_all( $raw ) {
		if ( ! is_array( $raw ) ) {
			return array();
		}

		$out   = array();
		$limit = LBSH_License::location_limit();

		foreach ( array_values( $raw ) as $index => $location ) {
			if ( PHP_INT_MAX !== $limit && count( $out ) >= $limit ) {
				break;
			}

			$clean = self::sanitize( (array) $location );

			if ( '' === $clean['name'] ) {
				continue;
			}

			if ( '' === $clean['id'] ) {
				$clean['id'] = (string) ( $index + 1 );
			}

			$out[] = $clean;
		}

		return $out;
	}

	/**
	 * Sanitize a single location.
	 *
	 * @param array $raw Untrusted input.
	 * @return array
	 */
	public static function sanitize( array $raw ) {
		$clean = self::blank();

		$clean['id'] = isset( $raw['id'] ) ? sanitize_key( $raw['id'] ) : '';

		foreach ( self::TEXT_FIELDS as $field ) {
			$clean[ $field ] = isset( $raw[ $field ] ) ? sanitize_text_field( $raw[ $field ] ) : '';
		}

		$clean['description'] = isset( $raw['description'] )
			? sanitize_textarea_field( $raw['description'] )
			: '';

		$clean['url']   = isset( $raw['url'] ) ? esc_url_raw( $raw['url'] ) : '';
		$clean['image'] = isset( $raw['image'] ) ? esc_url_raw( $raw['image'] ) : '';
		$clean['email'] = isset( $raw['email'] ) ? sanitize_email( $raw['email'] ) : '';

		$types = LBSH_Schema::types();

		if ( ! isset( $types[ $clean['type'] ] ) ) {
			$clean['type'] = 'LocalBusiness';
		}

		if ( ! in_array( $clean['timezone'], timezone_identifiers_list(), true ) ) {
			$clean['timezone'] = wp_timezone_string();
		}

		$clean['sameas'] = '';

		if ( isset( $raw['sameas'] ) ) {
			$urls = array_filter( array_map( 'esc_url_raw', array_map( 'trim', explode( "\n", (string) $raw['sameas'] ) ) ) );
			$clean['sameas'] = implode( "\n", $urls );
		}

		$clean['weekly']     = self::sanitize_weekly( isset( $raw['weekly'] ) ? $raw['weekly'] : array() );
		$clean['exceptions'] = self::sanitize_exceptions( isset( $raw['exceptions'] ) ? $raw['exceptions'] : array() );

		return $clean;
	}

	/**
	 * Sanitize submitted weekly hours.
	 *
	 * @param mixed $raw Untrusted weekly hours.
	 * @return array
	 */
	private static function sanitize_weekly( $raw ) {
		$weekly = array();

		foreach ( LBSH_Schedule::DAYS as $day ) {
			$weekly[ $day ] = array();

			if ( empty( $raw[ $day ] ) || ! is_array( $raw[ $day ] ) ) {
				continue;
			}

			foreach ( $raw[ $day ] as $period ) {
				if ( ! is_array( $period ) ) {
					continue;
				}

				$open  = LBSH_Schedule::normalize_time( isset( $period['open'] ) ? $period['open'] : '' );
				$close = LBSH_Schedule::normalize_time( isset( $period['close'] ) ? $period['close'] : '' );

				if ( null === $open || null === $close ) {
					continue;
				}

				$weekly[ $day ][] = array(
					'open'  => $open,
					'close' => $close,
				);
			}
		}

		return $weekly;
	}

	/**
	 * Sanitize submitted date exceptions.
	 *
	 * Accepts rows of date plus optional open/close, which is how the admin
	 * screen posts them, and collapses them into the storage shape.
	 *
	 * @param mixed $raw Untrusted exceptions.
	 * @return array
	 */
	private static function sanitize_exceptions( $raw ) {
		if ( ! is_array( $raw ) ) {
			return array();
		}

		$out = array();

		foreach ( $raw as $key => $row ) {
			$date = is_array( $row ) && isset( $row['date'] ) ? trim( (string) $row['date'] ) : (string) $key;

			if ( ! preg_match( '/^(\d{4}-)?\d{2}-\d{2}$/', $date ) ) {
				continue;
			}

			$periods = array();

			if ( is_array( $row ) && ! empty( $row['open'] ) && ! empty( $row['close'] ) ) {
				$open  = LBSH_Schedule::normalize_time( $row['open'] );
				$close = LBSH_Schedule::normalize_time( $row['close'] );

				if ( null !== $open && null !== $close ) {
					$periods[] = array(
						'open'  => $open,
						'close' => $close,
					);
				}
			} elseif ( is_array( $row ) && ! isset( $row['date'] ) ) {
				foreach ( $row as $period ) {
					if ( ! is_array( $period ) || empty( $period['open'] ) || empty( $period['close'] ) ) {
						continue;
					}

					$open  = LBSH_Schedule::normalize_time( $period['open'] );
					$close = LBSH_Schedule::normalize_time( $period['close'] );

					if ( null !== $open && null !== $close ) {
						$periods[] = array(
							'open'  => $open,
							'close' => $close,
						);
					}
				}
			}

			$out[ $date ] = $periods;
		}

		return $out;
	}
}
