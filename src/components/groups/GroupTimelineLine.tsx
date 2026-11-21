import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupLine } from '@massalabs/gossip-sdk';
import { lineTexts } from '../../utils/groupTimeline';
import { useAccountStore } from '../../stores/accountStore';

interface GroupTimelineLineProps {
  line: GroupLine;
  memberName: (userId: string) => string;
}

/** A line of the group timeline (§7.5), centred like a date separator. */
const GroupTimelineLine: React.FC<GroupTimelineLineProps> = ({
  line,
  memberName,
}) => {
  const { t } = useTranslation('groups');
  const me = useAccountStore(st => st.userProfile?.userId);
  const texts = lineTexts(line, memberName, t, me);
  if (texts.length === 0) return null;
  return (
    <div className="flex justify-center my-3 px-6" data-testid="group-line">
      <div className="text-center text-xs text-muted-foreground bg-muted/60 rounded-full px-3 py-1 max-w-full">
        {texts.map((text, i) => (
          <p key={i} dir="auto" className="[unicode-bidi:isolate] break-words">
            {text}
          </p>
        ))}
      </div>
    </div>
  );
};

export default GroupTimelineLine;
