<?php
/**
 * Dependency-free tests for LBSH_Schedule. Run with: php tests/test-schedule.php
 *
 * @package Local_Business_Schema_Hours
 */

define( 'ABSPATH', __DIR__ );

require __DIR__ . '/../includes/class-lbsh-schedule.php';
require __DIR__ . '/../includes/class-lbsh-schema.php';

$passed = 0;
$failed = 0;

/**
 * Assert equality between an expected and actual value.
 *
 * @param string $label    Test name.
 * @param mixed  $expected Expected value.
 * @param mixed  $actual   Actual value.
 * @return void
 */
function check( $label, $expected, $actual ) {
	global $passed, $failed;

	if ( $expected === $actual ) {
		$passed++;
		echo "  ok  - {$label}\n";
		return;
	}

	$failed++;
	echo "  FAIL- {$label}\n";
	echo '        expected: ' . var_export( $expected, true ) . "\n";
	echo '        actual:   ' . var_export( $actual, true ) . "\n";
}

/**
 * Build a moment in a fixed timezone.
 *
 * @param string $iso      Date/time string.
 * @param string $timezone Timezone identifier.
 * @return DateTimeImmutable
 */
function moment( $iso, $timezone = 'Europe/Vilnius' ) {
	return new DateTimeImmutable( $iso, new DateTimeZone( $timezone ) );
}

$weekday = array( array( 'open' => '08:00', 'close' => '17:00' ) );

$bakery = new LBSH_Schedule(
	array(
		'mon' => $weekday,
		'tue' => $weekday,
		'wed' => $weekday,
		'thu' => $weekday,
		'fri' => $weekday,
		'sat' => array( array( 'open' => '09:00', 'close' => '14:00' ) ),
	),
	array(
		'2026-12-25' => array(),
		'12-31'      => array( array( 'open' => '09:00', 'close' => '12:00' ) ),
	),
	'Europe/Vilnius'
);

echo "LBSH_Schedule\n";

check( 'open during weekday hours', true, $bakery->is_open( moment( '2026-09-10 10:00' ) ) );
check( 'closed before opening', false, $bakery->is_open( moment( '2026-09-10 07:59' ) ) );
check( 'open at the opening instant', true, $bakery->is_open( moment( '2026-09-10 08:00' ) ) );
check( 'closed at the closing instant', false, $bakery->is_open( moment( '2026-09-10 17:00' ) ) );
check( 'closed on an unlisted day', false, $bakery->is_open( moment( '2026-09-13 10:00' ) ) );
check( 'saturday uses its own hours', true, $bakery->is_open( moment( '2026-09-12 13:00' ) ) );
check( 'saturday closes earlier', false, $bakery->is_open( moment( '2026-09-12 15:00' ) ) );

check( 'one-off exception closes the day', false, $bakery->is_open( moment( '2026-12-25 10:00' ) ) );
check( 'annual exception applies in 2026', true, $bakery->is_open( moment( '2026-12-31 10:00' ) ) );
check( 'annual exception applies in 2027 too', true, $bakery->is_open( moment( '2027-12-31 10:00' ) ) );
check( 'annual exception shortens the day', false, $bakery->is_open( moment( '2026-12-31 13:00' ) ) );

$next = $bakery->next_change( moment( '2026-09-10 10:00' ) );
check( 'reports next closing while open', 'closes', $next['state'] );
check( 'closing time is correct', '2026-09-10 17:00', $next['at']->format( 'Y-m-d H:i' ) );

$next = $bakery->next_change( moment( '2026-09-10 18:00' ) );
check( 'reports next opening while closed', 'opens', $next['state'] );
check( 'opening rolls to the next day', '2026-09-11 08:00', $next['at']->format( 'Y-m-d H:i' ) );

$next = $bakery->next_change( moment( '2026-09-12 15:00' ) );
check( 'skips closed sunday', '2026-09-14 08:00', $next['at']->format( 'Y-m-d H:i' ) );

$next = $bakery->next_change( moment( '2026-12-24 18:00' ) );
// 2026-12-26 is a Saturday, so the schedule resumes on Saturday hours.
check( 'skips a holiday closure', '2026-12-26 09:00', $next['at']->format( 'Y-m-d H:i' ) );

$always_closed = new LBSH_Schedule( array(), array(), 'UTC' );
check( 'empty schedule is never open', false, $always_closed->is_open( moment( '2026-09-10 10:00', 'UTC' ) ) );
check( 'empty schedule has no next change', null, $always_closed->next_change( moment( '2026-09-10 10:00', 'UTC' ) ) );

$bar = new LBSH_Schedule(
	array(
		'fri' => array( array( 'open' => '20:00', 'close' => '03:00' ) ),
	),
	array(),
	'Europe/Vilnius'
);

check( 'overnight period open before midnight', true, $bar->is_open( moment( '2026-09-11 23:00' ) ) );
check( 'overnight period open after midnight', true, $bar->is_open( moment( '2026-09-12 02:00' ) ) );
check( 'overnight period closed after close', false, $bar->is_open( moment( '2026-09-12 03:30' ) ) );
check( 'overnight period closed on saturday night', false, $bar->is_open( moment( '2026-09-12 23:00' ) ) );

$twentyfour = new LBSH_Schedule(
	array( 'mon' => array( array( 'open' => '00:00', 'close' => '24:00' ) ) ),
	array(),
	'UTC'
);

check( '24h period covers late evening', true, $twentyfour->is_open( moment( '2026-09-07 23:59', 'UTC' ) ) );
check( '24h period ends at midnight', false, $twentyfour->is_open( moment( '2026-09-08 00:00', 'UTC' ) ) );

// Vilnius is UTC+3 in September, so 06:00 UTC is 09:00 local: open.
check(
	'timezone is respected across offsets',
	true,
	$bakery->is_open( new DateTimeImmutable( '2026-09-10 06:00', new DateTimeZone( 'UTC' ) ) )
);
// 04:00 UTC is 07:00 local, an hour before opening.
check(
	'moment outside local hours is closed',
	false,
	$bakery->is_open( new DateTimeImmutable( '2026-09-10 04:00', new DateTimeZone( 'UTC' ) ) )
);

check(
	'groups consecutive identical days',
	array( 'Mo-Fr 08:00-17:00', 'Sa 09:00-14:00' ),
	$bakery->to_opening_hours_strings()
);

check( 'drops malformed periods', array(), LBSH_Schedule::normalize_weekly( array( 'mon' => array( array( 'open' => '99:00', 'close' => '17:00' ) ) ) )['mon'] );
check( 'pads single-digit hours', '08:30', LBSH_Schedule::normalize_time( '8:30' ) );
check( 'rejects non-time input', null, LBSH_Schedule::normalize_time( 'lunchtime' ) );

echo "\nLBSH_Schema\n";

$schema = LBSH_Schema::build(
	array(
		'name'      => 'Wildflour Bakery',
		'type'      => 'Bakery',
		'url'       => 'https://example.com',
		'telephone' => '+370 600 00000',
		'street'    => 'Pilies g. 1',
		'city'      => 'Vilnius',
		'region'    => '',
		'postcode'  => '01123',
		'country'   => 'LT',
		'latitude'  => '54.6872',
		'longitude' => '25.2797',
		'price_range' => '$$',
	),
	$bakery
);

check( 'uses the configured business type', 'Bakery', $schema['@type'] );
check( 'includes a postal address', 'PostalAddress', $schema['address']['@type'] );
check( 'omits empty address fields', false, array_key_exists( 'addressRegion', $schema['address'] ) );
check( 'includes geo coordinates', 54.6872, $schema['geo']['latitude'] );
check( 'emits opening hours specification', 6, count( $schema['openingHoursSpecification'] ) );
check( 'marks christmas closed', true, in_array(
	array(
		'@type'       => 'OpeningHoursSpecification',
		'validFrom'   => '2026-12-25',
		'validThrough' => '2026-12-25',
		'opens'       => '00:00',
		'closes'      => '00:00',
	),
	$schema['specialOpeningHoursSpecification'],
	true
) );

$minimal = LBSH_Schema::build( array( 'name' => 'Corner Shop' ), $always_closed );
check( 'falls back to LocalBusiness', 'LocalBusiness', $minimal['@type'] );
check( 'omits geo when incomplete', false, array_key_exists( 'geo', $minimal ) );
check( 'omits address when empty', false, array_key_exists( 'address', $minimal ) );

echo "\n{$passed} passed, {$failed} failed\n";

exit( $failed > 0 ? 1 : 0 );
